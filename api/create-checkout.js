// POST /api/create-checkout
// 1. Holds the seats the customer picked — all of them or none
// 2. Opens a SumUp checkout for the correct amount
//
// The browser sends seat ids and one verified token per student ticket (from
// /api/student-code), never an amount: the number of tickets is the number of
// seats, the number of student tickets is the number of valid tokens, and the
// price is decided here.

import {
    applyCors, requireMethod, readBody,
    sbRpc, newBookingRef, supabaseConfigured
} from './_supabase.js';
import { openCheckout, baseUrlFor } from './_sumup.js';
import { cleanAccessNeeds, BOOKING_OPEN, MAX_PER_ORDER, priceFor, cleanStudentCount } from './_show.js';
import { cleanSeats, describeSeats, ACCESSIBLE_IDS } from '../seating.js';
import { seatRefusal } from './_seats.js';
import { studentsForTokens } from './_students.js';

/* The booking pause (BOOKING_OPEN) lives in api/_show.js, so Donna can
   read the same switch. */

// A hold with no expiry would be treated as already dead and its seats sold
// twice, so anything odd in the setting falls back to 15.
const HOLD_MINUTES   = Math.min(60, Math.max(5, parseInt(process.env.HOLD_MINUTES, 10) || 15));

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const clean   = (v, max = 120) => String(v ?? '').trim().slice(0, max);

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;

    if (!BOOKING_OPEN) {
        return res.status(503).json({
            error: 'Booking is paused just now while we confirm the seating plan for the hall. ' +
                   'Tickets will be back on sale very shortly — sorry for the inconvenience.'
        });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Booking system not configured' });
    }

    const body = readBody(req);
    const performanceDate = clean(body.performanceDate, 10);
    const customerName    = clean(body.customerName);
    const customerEmail   = clean(body.customerEmail, 160).toLowerCase();
    const customerPhone   = clean(body.customerPhone, 40);
    const bookedBy        = clean(body.bookedBy, 80) || 'WEB';

    // Access requirements: only codes we recognise are kept, so nothing the
    // browser invents reaches the door list.
    const accessNeeds     = cleanAccessNeeds(body.accessNeeds);
    const accessNotes     = clean(body.accessNotes, 300);

    // Seats, same treatment: anything that is not a seat on the plan in
    // seating.js falls out here, before it can reach the database.
    const asked           = Array.isArray(body.seats) ? body.seats.length : 0;
    const seats           = cleanSeats(body.seats);
    const quantity        = seats.length;
    const studentTokens   = Array.isArray(body.students) ? body.students.slice(0, 50) : [];
    const students        = cleanStudentCount(studentTokens.length, quantity);

    /* ---------------- validation ---------------- */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(performanceDate)) {
        return res.status(400).json({ error: 'Please choose a performance.' });
    }
    if (!quantity) {
        return res.status(400).json({ error: 'Please choose your seats on the plan.' });
    }
    if (quantity !== asked) {
        return res.status(400).json({ error: 'Some of those seats are not on the plan. Please choose again.' });
    }
    if (quantity > MAX_PER_ORDER) {
        return res.status(400).json({ error: `Please choose no more than ${MAX_PER_ORDER} seats in one booking.` });
    }
    if (students === null) {
        return res.status(400).json({ error: 'The number of student tickets must be between 0 and the number of seats.' });
    }
    if (customerName.length < 2) {
        return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (!isEmail(customerEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const SUMUP_API_KEY       = process.env.SUMUP_API_KEY;
    const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
        console.error('Missing SumUp credentials');
        return res.status(503).json({ error: 'Payment system not configured' });
    }

    // Every student ticket must come with a verified school address.
    const verified = await studentsForTokens(studentTokens);
    if (!verified.ok) {
        return res.status(400).json({ error: verified.error, studentProblem: true });
    }

    const amount = priceFor(quantity, students);
    const bookingRef = newBookingRef();

    /* ---------------- 1. hold the seats ----------------
       create_hold checks, under one lock per night, that every seat is free,
       not blocked, and not an accessible seat that is still kept back —
       then holds them all, or none. ACCESSIBLE_IDS is the list from
       seating.js; the database knows which of them have been released. */
    let booking;
    try {
        booking = await sbRpc('create_hold', {
            p_reference:    bookingRef,
            p_date:         performanceDate,
            p_seats:        seats,
            p_amount:       amount,
            p_name:         customerName,
            p_email:        customerEmail,
            p_phone:        customerPhone,
            p_booked_by:    bookedBy,
            p_hold_minutes: HOLD_MINUTES,
            p_access_needs: accessNeeds,
            p_access_notes: accessNotes,
            p_restricted:   ACCESSIBLE_IDS,
            p_student_quantity: students,
            p_students:     verified.students
        });
    } catch (err) {
        const msg = err.pgMessage || err.message || '';
        console.error('create_hold failed:', msg);

        const refused = seatRefusal(msg);
        if (refused && refused.kind === 'taken') {
            const gone = refused.seats;
            const which = gone.length === 1 ? `Seat ${gone[0]} was` : `Seats ${gone.join(', ')} were`;
            const rest = gone.length >= quantity
                ? `Please pick ${gone.length === 1 ? 'another' : 'others'}.`
                : `Your other seats are still selected — please pick ${gone.length === 1 ? 'one more' : gone.length + ' more'}.`;
            return res.status(409).json({
                error: `${which} taken a moment before you. ${rest}`,
                seatsTaken: gone
            });
        }
        if (refused && refused.kind === 'restricted') {
            return res.status(409).json({
                error: 'Accessible seats are not sold online. Use “Need accessible seating?” and the team will arrange them with you.',
                seatsRestricted: refused.seats
            });
        }
        if (msg.includes('DUPLICATE_SEATS') || msg.includes('NO_SEATS')) {
            return res.status(400).json({ error: 'Please choose your seats on the plan.' });
        }
        if (msg.includes('STUDENT_USED')) {
            const who = (msg.split('STUDENT_USED:')[1] || '').trim();
            return res.status(409).json({
                error: `${who || 'One of those school emails'} has already been used for a student ticket.`,
                studentProblem: true
            });
        }
        if (msg.includes('STUDENT_DUPLICATE')) {
            return res.status(400).json({ error: 'Each student ticket needs a different school email.', studentProblem: true });
        }
        if (msg.includes('BAD_STUDENT_QUANTITY') || msg.includes('STUDENT_NOT_VERIFIED')) {
            return res.status(400).json({ error: 'The number of student tickets must be between 0 and the number of seats.' });
        }
        if (msg.includes('NOT_ON_SALE')) {
            return res.status(409).json({ error: 'Tickets for that night are not on sale.' });
        }
        if (msg.includes('UNKNOWN_PERFORMANCE')) {
            return res.status(400).json({ error: 'That performance does not exist.' });
        }
        return res.status(500).json({ error: 'Could not reserve your tickets. Please try again.' });
    }

    /* ---------------- 2. open the SumUp checkout ----------------
       Shared with staff card payments from admin — see api/_sumup.js. If it
       fails, the hold is cancelled and the seats go straight back on sale. */
    const opened = await openCheckout({
        reference: bookingRef,
        amount,
        quantity,
        students,
        performanceDate,
        baseUrl: baseUrlFor(req)
    });

    if (!opened.ok) {
        return res.status(opened.status).json({ error: opened.error });
    }

    console.log('Sending customer to', opened.checkoutUrl);

    return res.status(200).json({
        bookingRef,
        checkoutId: opened.checkoutId,
        checkoutUrl: opened.checkoutUrl,
        amount,
        quantity,
        studentTickets: students,
        seats,
        seatsLabel: describeSeats(seats),
        performanceDate,
        holdMinutes: HOLD_MINUTES,
        expiresAt: booking?.held_until || null
    });
}
