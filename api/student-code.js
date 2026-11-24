// POST /api/student-code
//
//   { action: 'send',   email, name }  -> emails an SME Student code to a school address
//   { action: 'verify', code }         -> { token, email, name } when the code is right
//   { action: 'verify', code, email }  -> the same, for an old 6-digit code
//
// One code per school address, ever. Asking again is refused, not re-sent:
// the student uses the code already in their inbox. The code keeps working
// until it is on a paid booking (or sales end), so an abandoned payment just
// means typing it in again.
//
// New codes are 8 characters (K7PM-29XQ) and are enough on their own: the
// code finds the student. Codes sent before that were 6 digits; those are
// checked against the email they were sent to, as before.
//
// One file for both steps, so the project stays within Vercel's function
// limit. The token goes back with the booking (/api/create-checkout) and is
// what makes a ticket a student ticket. See api/_students.js.

import { applyCors, requireMethod, readBody, sbSelect, sbInsert, sbUpdate, sbDelete, supabaseConfigured } from './_supabase.js';
import { sendEmail, emailConfigured, buildStudentCode } from './_email.js';
import {
    STUDENT_DOMAIN, CODE_VALID_UNTIL, MAX_ATTEMPTS,
    hash, codeHash, newCode, formatCode, readCode, newToken, schoolEmail, studentAddressUsed
} from './_students.js';

const oneLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

/* Best-effort flood guards per warm instance, as on the contact form: all
   requests, and wrong codes. An 8-character code cannot be guessed in any
   number of tries a person could make; these stop a script hammering one
   instance. Old 6-digit codes also lock their email after MAX_ATTEMPTS. */
const recent = new Map();
function tooMany(key, max, windowMs) {
    const now = Date.now();
    const hits = (recent.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    recent.set(key, hits);
    if (recent.size > 4000) recent.clear();
    return hits.length > max;
}
const peek = (key, windowMs) => (recent.get(key) || []).filter(t => Date.now() - t < windowMs).length;

const WRONG_MAX = 10, WRONG_WINDOW = 60 * 60 * 1000;   // wrong codes per IP per hour

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;
    if (!supabaseConfigured()) return res.status(503).json({ error: 'Booking system not configured' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooMany('all:' + ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });

    const body = readBody(req);
    try {
        if (body.action === 'send')   return await send(res, body);
        if (body.action === 'verify') return await verify(res, body, ip);
        return res.status(400).json({ error: 'Unknown action.' });
    } catch (err) {
        console.error('student-code error:', err);
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}

const notSchool = res => res.status(400).json({ error: `Student tickets need a school email ending @${STUDENT_DOMAIN}.` });
const ALREADY_SENT = 'A code has already been sent to that school email. ' +
                     'Check that inbox (and junk folder) and use that code when booking.';
const USED = 'That code has already been used for an SME Student ticket.';

async function send(res, body) {
    const email = schoolEmail(body.email);
    if (!email) return notSchool(res);
    const name = oneLine(body.name, 80);
    if (name.length < 2) return res.status(400).json({ error: "Please enter the student's name." });
    if (!emailConfigured()) return res.status(503).json({ error: 'Email is not set up yet, so student tickets cannot be verified.' });

    if (await studentAddressUsed(email)) {
        return res.status(409).json({ error: 'That school email has already been used for an SME Student ticket.', used: true });
    }

    // A code nobody else has. With ~850 billion codes a clash is close to
    // impossible, but checking costs one lookup.
    let code;
    for (let i = 0; i < 5; i++) {
        code = newCode();
        const clash = await sbSelect(`student_codes?select=id&code_hash=eq.${codeHash(code)}&limit=1`);
        if (!clash.length) break;
    }

    let row;
    try {
        // The unique index on email makes this the one and only code.
        [row] = await sbInsert('student_codes', [{
            email,
            student_name: name,
            code_hash: codeHash(code),
            expires_at: CODE_VALID_UNTIL
        }]);
    } catch (err) {
        if (/23505|duplicate key/.test(err.message)) {
            return res.status(409).json({ error: ALREADY_SENT, alreadySent: true });
        }
        throw err;
    }

    try {
        await sendEmail(buildStudentCode({ to: email, name, code: formatCode(code) }));
    } catch (err) {
        // Nothing went out, so nothing is used up: let them try again.
        console.error('student code email failed:', err.message);
        await sbDelete('student_codes', `id=eq.${row.id}`).catch(() => {});
        return res.status(502).json({ error: 'Could not send the code just now. Please try again.' });
    }

    return res.status(200).json({ sent: true });
}

async function verify(res, body, ip) {
    const typed = readCode(body.code);
    if (!typed) return res.status(400).json({ error: 'That doesn\'t look like a code. It is 8 letters and numbers, like K7PM-29XQ.' });

    if (peek('wrong:' + ip, WRONG_WINDOW) >= WRONG_MAX) {
        return res.status(429).json({ error: 'Too many wrong codes. Please wait an hour, or contact us.' });
    }
    const wrong = message => {
        tooMany('wrong:' + ip, WRONG_MAX, WRONG_WINDOW);
        return res.status(400).json({ error: message });
    };

    let row;
    if (typed.kind === 'code') {
        [row] = await sbSelect(
            'student_codes?select=id,email,student_name,expires_at' +
            `&code_hash=eq.${codeHash(typed.code)}&limit=1`
        );
        if (!row) return wrong('That code isn\'t right. Check it against the email — codes never use the letters O, I or L.');
    } else {
        // An old 6-digit code: checked against the email it was sent to.
        const email = schoolEmail(body.email);
        if (!email) return res.status(400).json({ error: 'For a 6-digit code, enter the school email it was sent to as well.', needEmail: true });
        [row] = await sbSelect(
            'student_codes?select=id,email,student_name,code_hash,expires_at,attempts' +
            `&email=eq.${encodeURIComponent(email)}&limit=1`
        );
        if (!row) return wrong('No code was sent to that email.');
        if (row.attempts >= MAX_ATTEMPTS) {
            return res.status(429).json({ error: 'Too many wrong tries — this email is locked. Please contact us to unlock it.', locked: true });
        }
        if (codeHash(typed.code, email) !== row.code_hash) {
            await sbUpdate('student_codes', `id=eq.${row.id}`, { attempts: row.attempts + 1 });
            const left = MAX_ATTEMPTS - row.attempts - 1;
            return wrong(left > 0
                ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
                : 'Too many wrong tries — this email is locked. Please contact us to unlock it.');
        }
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'SME Student tickets are no longer on sale.' });
    }
    if (await studentAddressUsed(row.email)) {
        return res.status(409).json({ error: USED, used: true });
    }

    // A fresh token each time the code is typed in; the old one stops working.
    const token = newToken();
    await sbUpdate('student_codes', `id=eq.${row.id}`, {
        verified_at: new Date().toISOString(),
        token_hash: hash('token', token)
    });

    return res.status(200).json({ token, email: row.email, name: row.student_name });
}
