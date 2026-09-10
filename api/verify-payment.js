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
 * Send the confirmation right now, but never let it break the response.
 *
 * Paid and confirmed means the email goes immediately — we wait for the
 * provider here rather than handing it to the reconciler, so the customer
 * usually has it before they have finished reading this page.
 *
 * Two attempts back to back: a failed send releases its own claim, and most
 * failures are one provider having a bad second rather than anything
 * permanent. If both go, the booking still stands and the reconciler retries.
 */
async function confirmationAttempt(reference, booking, req) {
    if (booking?.confirmation_sent_at) return { status: 'already sent' };

    const url = siteUrl(req);
    let lastSkip = null;

    // Only the first verify for a booking gets the second go. Repeat page
    // loads take one attempt each, so a genuinely broken address cannot burn
    // through the reconciler's retry budget in a couple of refreshes.
    const tries = (booking?.confirmation_attempts || 0) === 0 ? 2 : 1;

    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const result = await sendConfirmationFor(reference, { url });

            if (result.sent) return { status: 'sent' };

            if (result.skipped) {
                lastSkip = result.skipped;

                // Someone else is mid-send, or the row has not caught up yet.
                // Worth a second look; anything else is final.
                if (result.skipped === 'already sent') return { status: 'already sent' };
                if (result.skipped !== 'another send is already in flight' &&
                    result.skipped !== 'booking not confirmed') {
                    return { status: 'skipped', detail: result.skipped };
                }
                continue;
            }

            console.error('confirmation send failed for', reference, result.error);
        } catch (err) {
            console.error('confirmation attempt threw:', err);
        }
    }

    // Confirmed and paid either way — the reconciler keeps trying.
    return { status: 'queued', detail: lastSkip || 'will retry shortly' };
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
