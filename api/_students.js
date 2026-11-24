// Student tickets: proving a ticket belongs to a St Mary's student.
//
// A student ticket needs a school address (@stmarysedenderry.ie by default).
// We email ONE code to it, ever — a second request is refused rather than
// sent; typing the code back proves the person can read that mailbox. Staff
// and students share the domain and cannot be told apart — that is accepted:
// the saving is €5.
//
// Codes are 8 characters, like K7PM-29XQ, from 31 letters and digits with
// the look-alikes left out (no 0/O, 1/I/L). That is about 850 billion
// possible codes for ~1,000 students, so a code is enough on its own at
// booking: guessing one that someone was sent is hopeless. Codes sent before
// this change were 6 digits; those still work, typed in with the email.
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

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

/** A new 8-character code, without the dash: 'K7PM29XQ'. */
export function newCode() {
    let out = '';
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    return out;
}

/** 'K7PM29XQ' -> 'K7PM-29XQ', as shown in the email. */
export const formatCode = code => code.slice(0, 4) + '-' + code.slice(4);

/**
 * What the person typed, tidied: ' k7pm 29xq ' -> { kind: 'code', code: 'K7PM29XQ' };
 * '482 913' -> { kind: 'legacy', code: '482913' }; anything else -> null.
 */
export function readCode(value) {
    const raw = String(value || '').toUpperCase().replace(/[\s-]/g, '');
    if (/^\d{6}$/.test(raw)) return { kind: 'legacy', code: raw };
    if (CODE_RE.test(raw)) return { kind: 'code', code: raw };
    return null;
}

/** The hash a code is stored under: new codes on their own, old ones with the email. */
export const codeHash = (code, email = null) =>
    email ? hash('code', email, code) : hash('code8', code);

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
