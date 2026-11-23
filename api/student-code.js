// POST /api/student-code
//
//   { action: 'send',   email, name }  -> emails a 6-digit code to a school address
//   { action: 'verify', email, code }  -> { token, email, name } when the code is right
//
// One code per school address, ever. Asking again is refused, not re-sent:
// the student uses the code already in their inbox. The code keeps working
// until it is on a paid booking (or sales end), so an abandoned payment just
// means typing it in again.
//
// One file for both steps, so the project stays within Vercel's function
// limit. The token goes back with the booking (/api/create-checkout) and is
// what makes a ticket a student ticket. See api/_students.js.

import { applyCors, requireMethod, readBody, sbSelect, sbInsert, sbUpdate, sbDelete, supabaseConfigured } from './_supabase.js';
import { sendEmail, emailConfigured, buildStudentCode } from './_email.js';
import {
    STUDENT_DOMAIN, CODE_VALID_UNTIL, MAX_ATTEMPTS,
    hash, newCode, newToken, schoolEmail, studentAddressUsed
} from './_students.js';

const oneLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

/* Best-effort flood guard per warm instance, as on the contact form. The real
   limits (one code per address, guesses per code) are in the database. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const recent = new Map();
function tooMany(ip) {
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter(t => now - t < WINDOW_MS);
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 2000) recent.clear();
    return hits.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;
    if (!supabaseConfigured()) return res.status(503).json({ error: 'Booking system not configured' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooMany(ip)) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });

    const body = readBody(req);
    const email = schoolEmail(body.email);
    if (!email) {
        return res.status(400).json({ error: `Student tickets need a school email ending @${STUDENT_DOMAIN}.` });
    }

    try {
        if (body.action === 'send')   return await send(res, email, oneLine(body.name, 80));
        if (body.action === 'verify') return await verify(res, email, oneLine(body.code, 12).replace(/\s/g, ''));
        return res.status(400).json({ error: 'Unknown action.' });
    } catch (err) {
        console.error('student-code error:', err);
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}

const ALREADY_SENT = 'A code has already been sent to that school email. ' +
                     'Check that inbox (and junk folder) and use that code when booking.';

async function send(res, email, name) {
    if (name.length < 2) return res.status(400).json({ error: "Please enter the student's name." });
    if (!emailConfigured()) return res.status(503).json({ error: 'Email is not set up yet, so student tickets cannot be verified.' });

    if (await studentAddressUsed(email)) {
        return res.status(409).json({ error: 'That school email has already been used for a student ticket.', used: true });
    }

    const code = newCode();
    let row;
    try {
        // The unique index on email makes this the one and only code.
        [row] = await sbInsert('student_codes', [{
            email,
            student_name: name,
            code_hash: hash('code', email, code),
            expires_at: CODE_VALID_UNTIL
        }]);
    } catch (err) {
        if (/23505|duplicate key/.test(err.message)) {
            return res.status(409).json({ error: ALREADY_SENT, alreadySent: true });
        }
        throw err;
    }

    try {
        await sendEmail(buildStudentCode({ to: email, name, code }));
    } catch (err) {
        // Nothing went out, so nothing is used up: let them try again.
        console.error('student code email failed:', err.message);
        await sbDelete('student_codes', `id=eq.${row.id}`).catch(() => {});
        return res.status(502).json({ error: 'Could not send the code just now. Please try again.' });
    }

    return res.status(200).json({ sent: true });
}

async function verify(res, email, code) {
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'The code is 6 digits.' });

    const [row] = await sbSelect(
        'student_codes?select=id,student_name,code_hash,expires_at,attempts' +
        `&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    if (!row) return res.status(400).json({ error: 'Send a code to that email first.' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'Student tickets are no longer on sale.' });
    }
    if (row.attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Too many wrong tries — this email is locked. Please contact us to unlock it.', locked: true });
    }
    if (await studentAddressUsed(email)) {
        return res.status(409).json({ error: 'That school email has already been used for a student ticket.', used: true });
    }

    if (hash('code', email, code) !== row.code_hash) {
        await sbUpdate('student_codes', `id=eq.${row.id}`, { attempts: row.attempts + 1 });
        const left = MAX_ATTEMPTS - row.attempts - 1;
        return res.status(400).json({
            error: left > 0
                ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
                : 'Too many wrong tries — this email is locked. Please contact us to unlock it.'
        });
    }

    // A fresh token each time the code is typed in; the old one stops working.
    const token = newToken();
    await sbUpdate('student_codes', `id=eq.${row.id}`, {
        verified_at: new Date().toISOString(),
        token_hash: hash('token', token)
    });

    return res.status(200).json({ token, email, name: row.student_name });
}
