// POST /api/create-checkout
// 1. Reserves the tickets (atomic, capacity-checked)
// 2. Opens a SumUp checkout for the correct amount
//
// The price is decided here, never by the browser.

import {
    applyCors, requireMethod, readBody,
    sbRpc, sbUpdate, newBookingRef, supabaseConfigured
} from './_supabase.js';

const TICKET_PRICE   = Number(process.env.TICKET_PRICE || 15);
const HOLD_MINUTES   = Number(process.env.HOLD_MINUTES || 15);
const MAX_PER_ORDER  = Number(process.env.MAX_PER_ORDER || 10);

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const clean   = (v, max = 120) => String(v ?? '').trim().slice(0, max);

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;

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

    const SUMUP_API_KEY       = process.env.SUMUP_API_KEY;
    const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
        console.error('Missing SumUp credentials');
        return res.status(503).json({ error: 'Payment system not configured' });
    }

    const amount = Number((quantity * TICKET_PRICE).toFixed(2));
    const bookingRef = newBookingRef();

    /* ---------------- 1. reserve the seats ---------------- */
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
            p_hold_minutes: HOLD_MINUTES
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
        if (msg.includes('NOT_ON_SALE')) {
            return res.status(409).json({ error: 'Tickets for that night are not on sale.' });
        }
        if (msg.includes('UNKNOWN_PERFORMANCE')) {
            return res.status(400).json({ error: 'That performance does not exist.' });
        }
        return res.status(500).json({ error: 'Could not reserve your tickets. Please try again.' });
    }

    /* ---------------- 2. open the SumUp checkout ---------------- */
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
            redirect_url: `${baseUrl}/success.html?ref=${bookingRef}`,
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
            return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
        }

        // SumUp's own hosted payment page. It usually hands back the URL; when
        // it doesn't, the URL is simply the checkout id on checkout.sumup.com.
        const checkoutUrl = checkout.hosted_checkout_url || `https://checkout.sumup.com/pay/${checkout.id}`;
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
            performanceDate,
            holdMinutes: HOLD_MINUTES,
            expiresAt: booking?.held_until || null
        });

    } catch (err) {
        console.error('create-checkout error:', err);
        await sbUpdate('bookings', `booking_reference=eq.${bookingRef}`, {
            status: 'cancelled', held_until: null, notes: 'Checkout creation threw'
        }).catch(() => {});
        return res.status(500).json({ error: 'Something went wrong starting the payment.' });
    }
}
