// QR tickets: one code per ticket, checked at the door.
//
// A ticket's code is  <booking ref>.<ticket number>.<signature>
// e.g. MM-4F2K9A.2.k3Xz9QpL0w — the signature is an HMAC with a server secret,
// so nobody can make up a valid code, and nothing extra needs storing: the
// code can be rebuilt from the booking at any time. The first scan of a ticket
// is recorded in ticket_checkins; any later scan shows when it got in.
//
// Which ticket is which: tickets 1..S are the student tickets (S =
// student_quantity), the SME Student tickets, matched to the booking's
// students in name order; the rest are Standard, under the booking name. Seats go to tickets in plan
// order, so ticket 1 has the first seat. Moving a party to other seats does
// not change their codes.

import crypto from 'node:crypto';
import { cleanSeats, describeSeats } from '../seating.js';

const SECRET = process.env.TICKET_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-only';

function signature(ref, n) {
    return crypto.createHmac('sha256', SECRET).update(`${ref}.${n}`).digest('base64url').slice(0, 10);
}

export function ticketCode(ref, n) {
    return `${ref}.${n}.${signature(ref, n)}`;
}

/** 'MM-4F2K9A.2.k3Xz9QpL0w' -> { ref, n }, or null if it is not one of ours. */
export function parseTicketCode(text) {
    const m = /^(MM-[A-Z0-9]{6})\.(\d{1,2})\.([A-Za-z0-9_-]{10})$/.exec(String(text || '').trim());
    if (!m) return null;
    const [, ref, nText, sig] = m;
    const n = Number(nText);
    const want = Buffer.from(signature(ref, n));
    const got = Buffer.from(sig);
    if (n < 1 || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return { ref, n };
}

/**
 * Every ticket on a booking, in order. `booking` needs booking_seats(seat_id)
 * and booking_students(email, student_name) embedded.
 */
export function ticketsFor(booking) {
    const seats = cleanSeats((booking.booking_seats || []).map(s => s.seat_id));
    const students = [...(booking.booking_students || [])]
        .sort((a, b) => a.student_name.localeCompare(b.student_name) || a.email.localeCompare(b.email));
    const studentCount = booking.student_quantity || 0;

    const out = [];
    for (let n = 1; n <= booking.quantity; n++) {
        const isStudent = n <= studentCount;
        const st = isStudent ? students[n - 1] : null;
        const seat = seats[n - 1] || null;
        out.push({
            n,
            of: booking.quantity,
            kind: isStudent ? 'student' : 'standard',
            name: st ? st.student_name : booking.customer_name,
            email: st ? st.email : null,
            seat,
            seatLabel: seat ? describeSeats([seat]) : null,
            code: ticketCode(booking.booking_reference, n)
        });
    }
    return out;
}
