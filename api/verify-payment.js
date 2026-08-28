// POST /api/verify-payment  { bookingRef }
//
// Asks SumUp whether the money actually arrived, and only then confirms the
// booking. The browser can claim whatever it likes — this is the source of truth.

import {
    applyCors, requireMethod, readBody,
    sbSelect, sbUpdate, supabaseConfigured
} from './_supabase.js';
import { sendConfirmationFor } from './_confirmations.js';
import { siteUrl } from './_show.js';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;

    const { bookingRef } = readBody(req);

    if (!bookingRef || !/^MM-[A-Z0-9]{6}$/.test(String(bookingRef))) {
        return res.status(400).json({ error: 'Missing or invalid booking reference' });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Booking system not configured' });
    }

    const SUMUP_API_KEY = process.env.SUMUP_API_KEY;
    if (!SUMUP_API_KEY) {
        return res.status(503).json({ error: 'Payment system not configured' });
    }

    try {
        /* ---- what do we have on file? ---- */
        const [booking] = await sbSelect(
            `bookings?select=*&booking_reference=eq.${encodeURIComponent(bookingRef)}&limit=1`
        );

        if (!booking) {
            return res.status(404).json({ paid: false, error: 'Booking not found' });
        }

        // Already settled — nothing to ask SumUp, but make sure the email went.
        if (booking.status === 'confirmed' && ['paid', 'cash'].includes(booking.payment_status)) {
            const email = await confirmationAttempt(bookingRef, booking, req);
            return res.status(200).json({ paid: true, booking: publicView(booking), email });
        }

        /* ---- ask SumUp ---- */
        const response = await fetch(
            `https://api.sumup.com/v0.1/checkouts?checkout_reference=${encodeURIComponent(bookingRef)}`,
            { headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } }
        );

        if (!response.ok) {
            console.error('SumUp verify error', response.status, await response.text());
            return res.status(502).json({ paid: false, error: 'Could not check the payment' });
        }

        const checkouts = await response.json();
        const paid = Array.isArray(checkouts) ? checkouts.find(c => c.status === 'PAID') : null;

        if (!paid) {
            const status = Array.isArray(checkouts) && checkouts[0] ? checkouts[0].status : 'NOT_FOUND';
            return res.status(200).json({ paid: false, status, booking: publicView(booking) });
        }

        /* ---- guard against a mismatched amount ---- */
        if (Number(paid.amount) + 0.001 < Number(booking.amount)) {
            console.error('Amount mismatch', { ref: bookingRef, paid: paid.amount, expected: booking.amount });
            return res.status(409).json({ paid: false, error: 'Payment amount did not match the booking' });
        }

        /* ---- confirm ---- */
        const [updated] = await sbUpdate(
            'bookings',
            `booking_reference=eq.${encodeURIComponent(bookingRef)}`,
            {
                status: 'confirmed',
                payment_status: 'paid',
                payment_method: 'sumup',
                sumup_transaction_id: paid.transaction_id || paid.transactions?.[0]?.id || null,
                held_until: null
            }
        );

        const confirmed = updated || booking;
        const email = await confirmationAttempt(bookingRef, confirmed, req);

        return res.status(200).json({ paid: true, booking: publicView(confirmed), email });

    } catch (err) {
        console.error('verify-payment error:', err);
        return res.status(500).json({ paid: false, error: 'Something went wrong verifying the payment' });
    }
}

/**
 * Send the confirmation, but never let it break the response.
 *
 * The booking is already paid and confirmed in the database by this point.
 * If the email fails, the reconciler picks it up within the hour and the
 * customer still has their booking — so we swallow the error and report it.
 */
async function confirmationAttempt(reference, booking, req) {
    if (booking?.confirmation_sent_at) return { status: 'already sent' };

    try {
        const result = await sendConfirmationFor(reference, { url: siteUrl(req) });
        if (result.sent)    return { status: 'sent' };
        if (result.skipped) return { status: 'skipped', detail: result.skipped };
        return { status: 'queued', detail: 'will retry shortly' };
    } catch (err) {
        console.error('confirmation attempt threw:', err);
        return { status: 'queued', detail: 'will retry shortly' };
    }
}

/** Only the fields the ticket holder needs to see. */
function publicView(b) {
    return {
        reference: b.booking_reference,
        performanceDate: b.performance_date,
        quantity: b.quantity,
        amount: Number(b.amount),
        customerName: b.customer_name,
        customerEmail: maskEmail(b.customer_email),
        status: b.status,
        paymentStatus: b.payment_status
    };
}

/** j***e@gmail.com — enough to spot a typo, not enough to harvest. */
function maskEmail(email) {
    const [user, domain] = String(email || '').split('@');
    if (!domain) return '';
    const shown = user.length <= 2 ? user[0] : user[0] + '***' + user[user.length - 1];
    return shown + '@' + domain;
}
