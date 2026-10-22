// Opening a SumUp hosted checkout for a booking that is already holding its
// seats. Used by the public booking page (/api/create-checkout) and by staff
// taking a card payment online from admin Add booking — one way of doing it,
// so both are paid, verified and rescued exactly alike.
//
// The booking reference is the SumUp checkout_reference: verify-payment and
// the reconciler look the payment up by it.

import { sbUpdate, sbRpc } from './_supabase.js';

/**
 * Returns { ok: true, checkoutId, checkoutUrl } or { ok: false, status, error }.
 *
 * On failure the hold is cancelled and its seats go straight back on sale —
 * nobody can pay for a checkout that does not exist, so there is nothing to
 * wait for.
 */
export async function openCheckout({ reference, amount, quantity, performanceDate, baseUrl }) {
    const SUMUP_API_KEY       = process.env.SUMUP_API_KEY;
    const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
        console.error('Missing SumUp credentials');
        await giveUp(reference, 'SumUp is not configured');
        return { ok: false, status: 503, error: 'Payment system not configured' };
    }

    try {
        const payload = {
            checkout_reference: reference,
            amount,
            currency: 'EUR',
            merchant_code: SUMUP_MERCHANT_CODE,
            description: `Mamma Mia! — ${quantity} ticket${quantity === 1 ? '' : 's'} (${performanceDate})`,
            // Where SumUp sends the customer once they are done paying.
            redirect_url: `${baseUrl}/success.html?ref=${reference}`,
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
            await giveUp(reference, 'SumUp checkout could not be created');
            return { ok: false, status: 502, error: 'Could not start the payment. Please try again.' };
        }

        let checkout;
        try {
            checkout = JSON.parse(text);
        } catch {
            checkout = null;
        }

        if (!checkout || !checkout.id) {
            console.error('SumUp returned no checkout id', text);
            await giveUp(reference, 'SumUp returned no checkout id');
            return { ok: false, status: 502, error: 'Could not start the payment. Please try again.' };
        }

        // The payment page URL only ever comes from SumUp. There is no URL to
        // guess at: a checkout created without hosted_checkout.enabled has no
        // page behind it, so anything we made up here would 404.
        const checkoutUrl = checkout.hosted_checkout_url;

        if (!checkoutUrl) {
            console.error('SumUp created a checkout with no hosted_checkout_url', text);
            await giveUp(reference, 'SumUp returned no hosted checkout URL');
            return { ok: false, status: 502, error: 'Could not open the payment page. Please try again.' };
        }

        await sbUpdate('bookings', `booking_reference=eq.${reference}`, {
            sumup_checkout_id: checkout.id,
            payment_method: 'sumup'
        }).catch(e => console.error('could not store checkout id', e));

        return { ok: true, checkoutId: checkout.id, checkoutUrl };

    } catch (err) {
        console.error('SumUp checkout threw:', err);
        await giveUp(reference, 'Checkout creation threw');
        return { ok: false, status: 500, error: 'Something went wrong starting the payment.' };
    }
}

/**
 * Cancel a hold whose checkout never got off the ground and hand its seats
 * straight back. The hold would expire on its own and release_stale_seats
 * would sweep them, but a seat that nobody is paying for should not sit
 * greyed out on the map while somebody is looking at it.
 */
async function giveUp(reference, why) {
    await sbUpdate('bookings', `booking_reference=eq.${reference}`, {
        status: 'cancelled', held_until: null, notes: why
    }).catch(() => {});
    try {
        await sbRpc('release_booking_seats', { p_reference: reference });
    } catch (err) {
        console.error('could not release seats for', reference, err.message);
    }
}

/** This site's own address, for SumUp to send the customer back to. */
export function baseUrlFor(req) {
    const host     = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = String(host || '').includes('localhost') ? 'http' : 'https';
    return `${protocol}://${host}`;
}
