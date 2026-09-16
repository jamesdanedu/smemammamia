// POST /api/create-checkout
// 1. Reserves the tickets (atomic, capacity-checked)
// 2. Opens a SumUp checkout for the correct amount
//
// The price is decided here, never by the browser.

import {
    applyCors, requireMethod, readBody,
    sbRpc, sbSelect, sbUpdate, newBookingRef, supabaseConfigured
} from './_supabase.js';
import { cleanAccessNeeds } from './_show.js';
import { cleanSeats, allocateSeats, describeSeats } from '../seating.js';

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
const HOLD_MINUTES   = Number(process.env.HOLD_MINUTES || 15);
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
    const quantity        = parseInt(body.quantity, 10);
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
    let seats             = cleanSeats(body.seats);

    /* ---------------- validation ---------------- */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(performanceDate)) {
        return res.status(400).json({ error: 'Please choose a performance.' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_ORDER) {
        return res.status(400).json({ error: `Please choose between 1 and ${MAX_PER_ORDER} tickets.` });
    }
    if (customerName.length < 2) {
        return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (!isEmail(customerEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (seats.length && seats.length !== quantity) {
        return res.status(400).json({
            error: `Please choose ${quantity} seat${quantity === 1 ? '' : 's'} — you have chosen ${seats.length}.`
        });
    }

    const SUMUP_API_KEY       = process.env.SUMUP_API_KEY;
    const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
        console.error('Missing SumUp credentials');
        return res.status(503).json({ error: 'Payment system not configured' });
    }

    const amount = Number((quantity * TICKET_PRICE).toFixed(2));
    const bookingRef = newBookingRef();

    /* ---------------- 1. seats, if the browser did not choose ----------------
       Normally the booking page sends the seats the customer clicked. If it
       could not — an old page left open, a map that failed to load — we pick
       for them rather than sell a ticket with nowhere to sit. create_hold
       checks them again under its lock, so a seat taken in the meantime is
       still caught. */
    if (!seats.length) {
        try {
            const takenRows = await sbSelect(
                `taken_seats?select=seat_id&performance_date=eq.${encodeURIComponent(performanceDate)}`
            );
            seats = allocateSeats(quantity, takenRows.map(r => r.seat_id));
        } catch (err) {
            console.error('could not auto-allocate seats:', err.message);
        }
        if (seats.length !== quantity) {
            return res.status(409).json({
                error: 'We could not find that many seats together. Please choose your seats on the map.'
            });
        }
    }

    /* ---------------- 2. reserve the seats ---------------- */
    let booking;
    try {
        booking = await sbRpc('create_hold', {
            p_reference:    bookingRef,
            p_date:         performanceDate,
            p_quantity:     quantity,
            p_amount:       amount,
            p_name:         customerName,
            p_email:        customerEmail,
            p_phone:        customerPhone,
            p_booked_by:    bookedBy,
            p_hold_minutes: HOLD_MINUTES,
            p_access_needs: accessNeeds,
            p_access_notes: accessNotes,
            p_seats:        seats
        });
    } catch (err) {
        const msg = err.pgMessage || err.message || '';
        console.error('create_hold failed:', msg);

        if (msg.includes('SOLD_OUT')) {
            const left = parseInt(msg.split('SOLD_OUT:')[1], 10);
            return res.status(409).json({
                error: left > 0
                    ? `Sorry — only ${left} ticket${left === 1 ? '' : 's'} left for that night.`
                    : 'Sorry — that performance has just sold out.',
                remaining: Number.isFinite(left) ? left : 0
            });
        }
        if (msg.includes('SEAT_TAKEN')) {
            const gone = msg.split('SEAT_TAKEN:')[1].split(/[\s]/)[0].split(',').filter(Boolean);
            return res.status(409).json({
                error: gone.length === 1
                    ? `Seat ${gone[0]} was taken a moment before you. Please pick another.`
                    : `Seats ${gone.join(', ')} were taken a moment before you. Please pick others.`,
                seatsTaken: gone
            });
        }
        if (msg.includes('SEAT_COUNT_MISMATCH')) {
            return res.status(400).json({ error: 'Please choose one seat per ticket.' });
        }
        if (msg.includes('NOT_ON_SALE')) {
            return res.status(409).json({ error: 'Tickets for that night are not on sale.' });
        }
        if (msg.includes('UNKNOWN_PERFORMANCE')) {
            return res.status(400).json({ error: 'That performance does not exist.' });
        }
        return res.status(500).json({ error: 'Could not reserve your tickets. Please try again.' });
    }

    /* ---------------- 3. open the SumUp checkout ---------------- */
    const host     = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = String(host || '').includes('localhost') ? 'http' : 'https';
    const baseUrl  = `${protocol}://${host}`;

    try {
        const payload = {
            checkout_reference: bookingRef,
            amount,
            currency: 'EUR',
            merchant_code: SUMUP_MERCHANT_CODE,
            description: `Mamma Mia! — ${quantity} ticket${quantity === 1 ? '' : 's'} (${performanceDate})`,
            // Where SumUp sends the customer once they are done paying.
            redirect_url: `${baseUrl}/success.html?ref=${bookingRef}`,
            // Without this, SumUp builds an API-only checkout for its card
            // widget and returns no payment page — there is no URL to send
            // anyone to, and checkout.sumup.com answers 404.
            hosted_checkout: { enabled: true },
            payment_type: 'ecom'
        };

        const response = await fetch('https://api.sumup.com/v0.1/checkouts', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SUMUP_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        console.log('SumUp checkout response', response.status, text);

        if (!response.ok) {
            console.error('SumUp checkout error', response.status, text);
            // release the hold so the seats go straight back on sale
            await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
                status: 'cancelled', held_until: null, notes: 'SumUp checkout could not be created'
            }).catch(() => {});
            await releaseSeats(bookingRef);
            return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
        }

        let checkout;
        try {
            checkout = JSON.parse(text);
        } catch {
            checkout = null;
        }

        if (!checkout || !checkout.id) {
            console.error('SumUp returned no checkout id', text);
            await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
                status: 'cancelled', held_until: null, notes: 'SumUp returned no checkout id'
            }).catch(() => {});
            await releaseSeats(bookingRef);
            return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
        }

        // The payment page URL only ever comes from SumUp. There is no URL to
        // guess at: a checkout created without hosted_checkout.enabled has no
        // page behind it, so anything we made up here would 404.
        const checkoutUrl = checkout.hosted_checkout_url;

        if (!checkoutUrl) {
            console.error('SumUp created a checkout with no hosted_checkout_url', text);
            await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
                status: 'cancelled', held_until: null, notes: 'SumUp returned no hosted checkout URL'
            }).catch(() => {});
            await releaseSeats(bookingRef);
            return res.status(502).json({ error: 'Could not open the payment page. Please try again.' });
        }

        console.log('Sending customer to', checkoutUrl);

        await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
            sumup_checkout_id: checkout.id,
            payment_method: 'sumup'
        }).catch(e => console.error('could not store checkout id', e));

        return res.status(200).json({
            bookingRef,
            checkoutId: checkout.id,
            checkoutUrl,
            amount,
            quantity,
            seats,
            seatsLabel: describeSeats(seats),
            performanceDate,
            holdMinutes: HOLD_MINUTES,
            expiresAt: booking?.held_until || null
        });

    } catch (err) {
        console.error('create-checkout error:', err);
        await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
            status: 'cancelled', held_until: null, notes: 'Checkout creation threw'
        }).catch(() => {});
        await releaseSeats(bookingRef);
        return res.status(500).json({ error: 'Something went wrong starting the payment.' });
    }
}

/**
 * Hand the seats straight back when a checkout never got off the ground.
 * The hold would expire on its own within the quarter hour and release_stale_seats
 * would sweep them, but a seat that nobody is paying for should not sit greyed
 * out on the map while somebody is looking at it.
 */
async function releaseSeats(reference) {
    try {
        await sbRpc('release_booking_seats', { p_reference: reference });
    } catch (err) {
        console.error('could not release seats for', reference, err.message);
    }
}
