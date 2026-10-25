// POST /api/donna  { messages: [{ role: 'user'|'assistant', content, sig? }, ...] }
//   → { reply, sig }                      Donna's answer, signed so it can be sent back
//   → { reply, kind: 'rude'|'personal'|'distress'|'blocked' }   a fixed line instead
//   → 429 / 503 { reply, kind }           too many messages, or Donna is switched off
//
// "Ask Donna" — the chat bubble on the public pages (donna.js). The model is
// DeepSeek, called with plain fetch over its OpenAI-style API. Every reply is
// a 200 or carries a `reply` the panel can show, so the visitor always sees
// Donna say something rather than an error.
//
// In order, cheapest first:
//   1. distress → a fixed, kind answer   never the model, never a joke, never switched off
//   2. kill switch                       DONNA_ENABLED, DEEPSEEK_API_KEY
//   3. rate limits                       donna_tick() in Supabase (schema-donna.sql), DONNA_DAILY_CAP
//   4. word filter → a fixed brush-off   the model never sees it
//   5. personal-detail scrub             nothing identifying goes to DeepSeek
//   6. DeepSeek writes the reply
//   7. word filter + DeepSeek judge on the reply; anything doubtful → a fixed line
//
// Nothing visitors type is stored. The only rows written are anonymous
// counters, keyed on a salted hash of the IP, which expire within a day.

import crypto from 'node:crypto';
import { applyCors, readBody, sbRpc, supabaseConfigured } from './_supabase.js';
import { isRude, soundsLikeDistress, scrubPersonal, mostlyPersonal } from './_filter.js';
import { DONNA_SYSTEM, JUDGE_SYSTEM, LINES, PAGES, pick } from './_donna-prompt.js';

const API_KEY  = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL    = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const ENABLED  = process.env.DONNA_ENABLED !== 'false';
const DAILY_CAP = Math.max(0, parseInt(process.env.DONNA_DAILY_CAP, 10) || 2000);

/* Provider-specific request options, as JSON, merged into every request —
   for example a switch to turn a model's reasoning mode off. Check the
   provider's docs; tests/donna-live.mjs shows whether replies come back. */
let EXTRA = {};
try { EXTRA = JSON.parse(process.env.DEEPSEEK_EXTRA || '{}'); } catch { console.error('DEEPSEEK_EXTRA is not valid JSON'); }

const PER_10_MIN = 20;          // messages one visitor can send in ten minutes
const PER_DAY    = 60;          // and in a day
const MAX_USER_CHARS  = 300;
const MAX_REPLY_CHARS = 700;
const MAX_TURNS       = 8;      // the last eight messages are all the model sees

/* Signs Donna's replies, so the browser can send the conversation back
   without being able to put words in her mouth: an assistant turn whose
   signature doesn't match is dropped. */
const SECRET = process.env.DONNA_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || API_KEY || 'donna';
const sign = text => crypto.createHmac('sha256', SECRET).update('donna:' + text).digest('hex').slice(0, 32);
const signedOk = (text, sig) => {
    const want = Buffer.from(sign(text));
    const got = Buffer.from(String(sig || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
};

/* ---------------------------------------------------------------------------
   Rate limits. Supabase holds the counters so they survive across serverless
   instances; if it is missing or down, a per-instance count stands in — it
   stops a script hammering one warm instance, not much more.
   --------------------------------------------------------------------------- */
const local = { hits: new Map(), day: '', total: 0 };

function localTick(key) {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    if (local.day !== today) { local.day = today; local.total = 0; local.hits.clear(); }
    local.total++;
    const hits = (local.hits.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
    hits.push(now);
    local.hits.set(key, hits);
    if (local.hits.size > 5000) local.hits.clear();
    return { ip_10m: hits.length, ip_day: hits.length, all_day: local.total };
}

async function tick(req) {
    const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '')
        .split(',')[0].trim() || 'unknown';
    const key = crypto.createHmac('sha256', SECRET).update('ip:' + ip).digest('hex').slice(0, 24);
    if (supabaseConfigured()) {
        try {
            const rows = await sbRpc('donna_tick', { p_visitor: key });
            const row = Array.isArray(rows) ? rows[0] : rows;
            if (row) return row;
        } catch (err) {
            console.error('donna rate limit lookup failed:', err.message);
        }
    }
    return localTick(key);
}

/* ---------------------------------------------------------------------------
   The model. DeepSeek speaks the OpenAI chat format, so another provider with
   the same format is a change of DEEPSEEK_BASE_URL, DEEPSEEK_MODEL and the key.
   --------------------------------------------------------------------------- */
async function callModel(messages, { maxTokens, temperature, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({ ...EXTRA, model: MODEL, messages, max_tokens: maxTokens, temperature, stream: false })
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`);
        const choice = JSON.parse(text).choices?.[0];
        // A reply cut off by length or by DeepSeek's own filter is not a reply.
        if (!choice || choice.finish_reason !== 'stop') {
            throw new Error(`DeepSeek finished with ${choice?.finish_reason || 'no choice'}`);
        }
        return String(choice.message?.content || '').trim();
    } finally {
        clearTimeout(timer);
    }
}

/** OK from the judge, or anything at all going wrong, decides the reply. */
async function judgeSaysOk(reply) {
    try {
        const verdict = await callModel([
            { role: 'system', content: JUDGE_SYSTEM },
            { role: 'user', content: `<reply>\n${reply.replace(/<\/?reply>/gi, '')}\n</reply>` }
        ], { maxTokens: 10, temperature: 0, timeoutMs: 8000 });
        return /^\W*ok\W*$/i.test(verdict);
    } catch (err) {
        console.error('donna judge failed:', err.message);
        return false;   // fail closed: no verdict, no reply
    }
}

/* Links Donna may write: only [words](page.html) to our own pages. Anything
   else in the reply that looks like a link or address fails the check. */
function linksOk(reply) {
    for (const [, href] of reply.matchAll(/\]\(([^)]*)\)/g)) {
        if (!PAGES[href]) return false;
    }
    const bare = reply.replace(/\]\([^)]*\)/g, '](x)');
    return !/https?:|www\.|[^\s@]+@[^\s@]+\.[a-z]{2,}|\b[a-z0-9-]+\.(com|ie|net|org|io|co)\b/i.test(bare);
}

/* ---------------------------------------------------------------------------
   The conversation the browser sends back. Only well-formed turns survive:
   user turns are re-checked and re-scrubbed, assistant turns must carry
   Donna's signature.
   --------------------------------------------------------------------------- */
function cleanHistory(raw) {
    const list = Array.isArray(raw) ? raw.slice(-MAX_TURNS) : [];
    const out = [];
    for (const m of list) {
        const content = String(m?.content ?? '').trim();
        if (!content) continue;
        if (m.role === 'assistant') {
            if (content.length <= MAX_REPLY_CHARS && signedOk(content, m.sig)) {
                out.push({ role: 'assistant', content });
            }
        } else if (m.role === 'user') {
            const text = content.slice(0, MAX_USER_CHARS);
            if (isRude(text) || soundsLikeDistress(text)) continue;
            out.push({ role: 'user', content: scrubPersonal(text).text });
        }
    }
    // Same role twice in a row (a dropped turn between) — keep the later one,
    // and start on a visitor's turn.
    const tidy = out.filter((m, i) => out[i + 1]?.role !== m.role);
    if (tidy[0]?.role === 'assistant') tidy.shift();
    return tidy;
}

const say = (res, status, kind, list) => res.status(status).json({ reply: pick(list), kind });

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = readBody(req);
    const turns = Array.isArray(body.messages) ? body.messages : [];
    const last = turns[turns.length - 1];
    const question = String(last?.content ?? '').trim();
    if (last?.role !== 'user' || !question) {
        return res.status(400).json({ error: 'Ask Donna something first.' });
    }
    if (question.length > MAX_USER_CHARS) {
        return res.status(400).json({ error: `Keep it under ${MAX_USER_CHARS} characters, love.` });
    }

    // First of all: somebody in trouble always gets an answer, even when Donna is off.
    if (soundsLikeDistress(question)) return say(res, 200, 'distress', LINES.distress);

    if (!ENABLED || !API_KEY) return say(res, 503, 'closed', LINES.closed);

    const usage = await tick(req);
    if (usage.all_day > DAILY_CAP) return say(res, 503, 'closed', LINES.closed);
    if (usage.ip_10m > PER_10_MIN || usage.ip_day > PER_DAY) return say(res, 429, 'busy', LINES.busy);

    if (isRude(question))              return say(res, 200, 'rude', LINES.rude);

    const scrubbed = scrubPersonal(question);
    if (mostlyPersonal(scrubbed))      return say(res, 200, 'personal', LINES.personal);

    const history = cleanHistory(turns.slice(0, -1));
    if (history[history.length - 1]?.role === 'user') history.pop();
    const messages = [
        { role: 'system', content: DONNA_SYSTEM },
        ...history,
        { role: 'user', content: scrubbed.text }
    ];

    let reply;
    try {
        reply = await callModel(messages, { maxTokens: 300, temperature: 1.0, timeoutMs: 15000 });
    } catch (err) {
        console.error('donna reply failed:', err.message);
        return say(res, 200, 'blocked', LINES.busy);
    }

    if (!reply || reply.length > MAX_REPLY_CHARS || isRude(reply) || !linksOk(reply)
        || !(await judgeSaysOk(reply))) {
        console.warn('donna reply blocked');   // a count in the logs, never the text
        return say(res, 200, 'blocked', LINES.blocked);
    }

    return res.status(200).json({ reply, sig: sign(reply) });
}
