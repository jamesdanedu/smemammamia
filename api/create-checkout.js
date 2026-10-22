// POST /api/create-checkout
// 1. Holds the seats the customer picked — all of them or none
// 2. Opens a SumUp checkout for the correct amount
//
// The browser sends seat ids, never an amount and never a ticket count: the
// number of tickets is the number of seats, and the price is decided here.

import {
    applyCors, requireMethod, readBody,
    sbRpc, newBookingRef, supabaseConfigured
} from './_supabase.js';
import { openCheckout, baseUrlFor } from './_sumup.js';
import { cleanAccessNeeds } from './_show.js';
import { cleanSeats, describeSeats, ACCESSIBLE_IDS } from '../seating.js';
import { seatRefusal } from './_seats.js';

/* >>> BOOKING PAUSE — set back to true to reopen sales. <<<
   Moves together with CONFIG.features.bookingOpen in config.js. That one
   closes the pages; this one closes the door behind them, so a page somebody
   already had open — or anything posting straight at this endpoint — cannot
   still push a booking through.

   Deliberately NOT paused:
     · /api/admin cash and door bookings — staff can still take a booking.
     · /api/verify-payment and the reconciler — anyone who was mid-payment
       when this went on must still be able to finish and be confirmed,
       otherwise we would take the money and never issue the ticket. */
const BOOKING_OPEN = false;

const TICKET_PRICE   = Number(process.env.TICKET_PRICE || 10);
// A hold with no expiry would be treated as already dead and its seats sold
// twice, so anything odd in the setting falls back to 15.
const HOLD_MINUTES   = Math.min(60, Math.max(5, parseInt(process.env.HOLD_MINUTES, 10) || 15));
const MAX_PER_ORDER  = Number(process.env.MAX_PER_ORDER || 10);

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

    const amount = Number((quantity * TICKET_PRICE).toFixed(2));
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
            p_restricted:   ACCESSIBLE_IDS
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
        seats,
        seatsLabel: describeSeats(seats),
        performanceDate,
        holdMinutes: HOLD_MINUTES,
        expiresAt: booking?.held_until || null
    });
}
