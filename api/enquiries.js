// POST /api/enquiries  { name, email, phone, topic, bookingReference, message, website, elapsed }
//
// The contact form on contact.html. Emails the question to the show inbox
// (ENQUIRIES_TO, default smehighschoolmusical@gmail.com) with Reply-To set to
// the person who asked, so answering is just pressing Reply in Gmail.
//
// Uses the same Resend → Brevo failover as the confirmations. Nothing is
// stored: if both providers fail the person is told, so nothing is silently lost.

import { applyCors, readBody } from './_supabase.js';
import { sendEmail, emailConfigured } from './_email.js';
import { SHOW } from './_show.js';

const TO = process.env.ENQUIRIES_TO || 'smehighschoolmusical@gmail.com';

const TOPICS = {
    general: 'General question',
    booking: 'An existing booking',
    access:  'Access, seating or mobility',
    groups:  'A group or class booking',
    press:   'Press, photos or programme',
    other:   'Something else'
};

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const oneLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Best-effort flood guard. Per warm serverless instance only — it stops a
   script hammering the form, not a determined attacker. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map();

function tooMany(ip) {
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter(t => now - t < WINDOW_MS);
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 2000) recent.clear();
    return hits.length > MAX_PER_WINDOW;
}

function newRef() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return 'Q-' + out;
}

export function buildEnquiry(q, ref) {
    const topic = TOPICS[q.topic] || TOPICS.general;
    const subject = `[${ref}] ${topic} — ${q.name}`;
    const rows = [
        ['Reference', ref],
        ['From', q.name],
        ['Email', q.email],
        q.phone && ['Phone', q.phone],
        ['Topic', topic],
        q.bookingReference && ['Booking ref', q.bookingReference]
    ].filter(Boolean);

    const text = [
        `${SHOW.name} — website question`,
        '',
        ...rows.map(([k, v]) => `${(k + ':').padEnd(13)} ${v}`),
        '',
        q.message,
        '',
        '—',
        `Press Reply to answer ${q.name} directly.`
    ].join('\n');

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#fbf9f5;font-family:Helvetica,Arial,sans-serif;color:#22333f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2eaef;border-radius:4px;">
  <tr><td height="3" style="background:#1b6ca8;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:22px 26px 6px;">
    <div style="font-size:11px;letter-spacing:2px;color:#5b6f7c;text-transform:uppercase;">${esc(SHOW.name)} · website question</div>
    <div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:22px;color:#1b6ca8;padding-top:6px;">${esc(topic)}</div>
  </td></tr>
  <tr><td style="padding:10px 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:7px 0;border-bottom:1px solid #e2eaef;color:#5b6f7c;width:120px;">${esc(k)}</td>
        <td style="padding:7px 0;border-bottom:1px solid #e2eaef;">${k === 'Email'
            ? `<a href="mailto:${esc(v)}" style="color:#1b6ca8;">${esc(v)}</a>` : esc(v)}</td></tr>`).join('')}
    </table>
  </td></tr>
  <tr><td style="padding:14px 26px 6px;">
    <div style="background:#f4f8fa;border:1px solid #cbdae3;border-radius:3px;padding:14px 16px;font-size:15px;line-height:1.6;white-space:pre-wrap;">${esc(q.message)}</div>
  </td></tr>
  <tr><td style="padding:12px 26px 22px;font-size:12px;color:#5b6f7c;">Press Reply to answer ${esc(q.name)} directly.</td></tr>
</table>
</body></html>`;

    return { to: TO, subject, text, html, replyTo: q.email, bcc: false };
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const b = readBody(req);
    const q = {
        name:             oneLine(b.name, 80),
        email:            oneLine(b.email, 160),
        phone:            oneLine(b.phone, 40),
        topic:            TOPICS[b.topic] ? b.topic : 'general',
        bookingReference: oneLine(b.bookingReference, 20).toUpperCase(),
        message:          String(b.message ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1500)
    };

    // Bots: filled the hidden field, or submitted faster than a person can type.
    // Pretend it worked so they don't learn to adapt.
    if (String(b.website || '').trim() || (Number(b.elapsed) > 0 && Number(b.elapsed) < 2500)) {
        return res.status(200).json({ ok: true, reference: newRef() });
    }

    if (q.name.length < 2)      return res.status(400).json({ error: 'Please enter your name.' });
    if (!isEmail(q.email))      return res.status(400).json({ error: 'Please enter an email we can reply to.' });
    if (q.message.length < 2)   return res.status(400).json({ error: 'Please write your question.' });

    const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    if (tooMany(ip)) {
        return res.status(429).json({ error: 'That is a lot of questions in a short time — please try again in a few minutes.' });
    }

    if (!emailConfigured()) {
        console.error('enquiry not sent: email is not configured');
        return res.status(503).json({ error: 'The contact form is not switched on yet. Please try again later.' });
    }

    const ref = newRef();
    try {
        const sent = await sendEmail(buildEnquiry(q, ref));
        console.log(`enquiry ${ref} sent via ${sent.provider}`);
        return res.status(200).json({ ok: true, reference: ref });
    } catch (err) {
        console.error(`enquiry ${ref} failed:`, err.message);
        return res.status(502).json({ error: 'Sorry — your question could not be sent just now. Please try again in a minute.' });
    }
}
