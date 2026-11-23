// Student tickets: proving a ticket belongs to a St Mary's student.
//
// A student ticket needs a school address (@stmarysedenderry.ie by default).
// We email ONE 6-digit code to it, ever — a second request is refused rather
// than sent; typing the code back proves the person can read that mailbox. Staff and students share the domain and cannot be told
// apart — that is accepted: the saving is €5.
//
// Only hashes of codes and tokens are stored. The token handed to the browser
// after verification is what /api/create-checkout accepts for a student ticket.

import crypto from 'node:crypto';
import { sbSelect } from './_supabase.js';

export const STUDENT_DOMAIN = String(process.env.STUDENT_EMAIL_DOMAIN || 'stmarysedenderry.ie')
    .toLowerCase().replace(/^@/, '');

// One code per address, ever. It stays usable until sales end, so a student
// who abandons a payment books again with the same code from their inbox.
export const CODE_VALID_UNTIL = process.env.STUDENT_CODE_VALID_UNTIL || '2027-01-30T00:00:00Z';
export const TOKEN_MINUTES  = 60;   // after typing the code, this long to finish booking
export const MAX_ATTEMPTS   = 5;    // wrong guesses before the address is locked

const SECRET = process.env.STUDENT_CODE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-only';

export const hash = (...parts) =>
    crypto.createHash('sha256').update([SECRET, ...parts].join('|')).digest('hex');

export function newCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export function newToken() {
    return crypto.randomBytes(24).toString('base64url');
}

/** 'Amy.Cullen@StMarysEdenderry.ie ' -> 'amy.cullen@stmarysedenderry.ie', or null if not a school address. */
export function schoolEmail(value) {
    const e = String(value || '').trim().toLowerCase();
    if (e.length > 160) return null;
    const m = /^([a-z0-9._%+'-]+)@([a-z0-9.-]+)$/.exec(e);
    if (!m || m[2] !== STUDENT_DOMAIN) return null;
    return e;
}

/** True if this address already has a student ticket on a confirmed booking or a live hold. */
export async function studentAddressUsed(email) {
    const rows = await sbSelect(
        'booking_students?select=bookings!inner(status,held_until)' +
        `&email=eq.${encodeURIComponent(email)}`
    );
    const now = Date.now();
    return rows.some(r => {
        const b = r.bookings || {};
        return b.status === 'confirmed' ||
               (b.status === 'held' && b.held_until && new Date(b.held_until).getTime() > now);
    });
}

/**
 * Turn the tokens the browser sends into [{ email, name }], or explain why not.
 * Returns { ok: true, students } or { ok: false, error }.
 */
export async function studentsForTokens(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return { ok: true, students: [] };
    const clean = tokens.map(t => String(t || '').trim()).filter(t => /^[A-Za-z0-9_-]{20,64}$/.test(t));
    if (clean.length !== tokens.length) {
        return { ok: false, error: 'A student ticket has not been verified. Please check the codes.' };
    }

    const hashes = clean.map(t => hash('token', t));
    const rows = await sbSelect(
        'student_codes?select=email,student_name,verified_at,token_hash' +
        `&token_hash=in.(${hashes.join(',')})`
    );
    const cutoff = Date.now() - TOKEN_MINUTES * 60000;
    const students = [];
    for (const h of hashes) {
        const r = rows.find(x => x.token_hash === h);
        if (!r || !r.verified_at || new Date(r.verified_at).getTime() < cutoff) {
            return { ok: false, error: 'A student code has expired. Please verify that student again.' };
        }
        students.push({ email: r.email, name: r.student_name });
    }
    if (new Set(students.map(s => s.email)).size !== students.length) {
        return { ok: false, error: 'Each student ticket needs a different school email.' };
    }
    return { ok: true, students };
}
