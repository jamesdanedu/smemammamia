// GET|POST /api/reconcile      (Bearer CRON_SECRET, or ?secret=)
//
// The safety net. Two jobs, both idempotent, safe to run as often as you like.
//
//  1. RESCUE — someone paid and then closed the tab before the site could
//     confirm it. SumUp has their money; our database still says "held", and
//     the hold quietly expires. This asks SumUp about every abandoned
//     checkout and confirms the ones that were actually paid. Without this,
//     a customer can be charged and end up with no ticket.
//
//  2. RETRY — every confirmed booking whose email has not gone out yet.
//     Covers provider outages, a function killed mid-send, and anything the
//     browser never triggered.
//
// Run it on a schedule (see README). Nothing here depends on a webhook
// arriving or a browser staying open.

import { applyCors, sbSelect, sbRpc, supabaseConfigured } from './_supabase.js';
import { sendConfirmationFor, isRealAddress } from './_confirmations.js';
import { emailConfigured } from './_email.js';
import { siteUrl } from './_show.js';

const MAX_RESCUE = 40;   // per run — keeps us inside the serverless time limit
const MAX_EMAILS = 25;

/**
 * Who is allowed to run this.
 *
 * An unset CRON_SECRET is not an authentication failure, it is a deployment
 * that never finished being configured — and it is worth saying so out loud,
 * because the symptom is a scheduled run answering 401 forever while nothing
 * gets rescued and no confirmation is ever retried.
 */
function authCheck(req) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return { ok: false, unconfigured: true };

    const header = req.headers.authorization || '';
    if (header === `Bearer ${secret}`) return { ok: true };

    // Vercel Cron signs its own requests with CRON_SECRET, and strips any
    // x-vercel-* header arriving from outside, so this is a safe fallback.
    if (req.headers['x-vercel-cron']) return { ok: true };

    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('secret') === secret) return { ok: true };
    } catch { /* malformed URL is simply not authorised */ }

    return { ok: false };
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    const auth = authCheck(req);

    if (auth.unconfigured) {
        console.error(
            'reconcile refused: CRON_SECRET is not set, so every scheduled run is turned away. ' +
            'Set it in the Vercel environment variables and redeploy.'
        );
        return res.status(503).json({
            error: 'Reconciler is not configured',
            detail: 'CRON_SECRET is not set. Add it to the Vercel environment variables and redeploy — ' +
                    'Vercel Cron signs its requests with it, and until it is set no abandoned payment is ' +
                    'rescued and no unsent confirmation is retried.'
        });
    }

    if (!auth.ok) {
        console.error('reconcile refused: CRON_SECRET did not match');
        return res.status(401).json({ error: 'Unauthorised' });
    }
    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Database not configured' });
    }

    const summary = await runReconcile(siteUrl(req));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(summary);
}

/**
 * The work itself, so the admin dashboard's "Run now" button can call it
 * directly rather than making an HTTP round trip back to ourselves.
 */
export async function runReconcile(url = '') {
    const started = Date.now();
    const summary = {
        rescue: { checked: 0, rescued: 0, stillUnpaid: 0, errors: 0, references: [] },
        emails: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        emailConfigured: emailConfigured()
    };

    /* =====================================================================
       1. Rescue payments that never got confirmed
       ===================================================================== */
    const SUMUP_API_KEY = process.env.SUMUP_API_KEY;

    if (SUMUP_API_KEY) {
        try {
            // Anything that opened a SumUp checkout, is still sitting in
            // 'held', and is old enough that the customer has clearly gone.
            const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const stale = await sbSelect(
                'bookings?select=booking_reference,amount,performance_date,quantity' +
                '&status=eq.held&sumup_checkout_id=not.is.null' +
                `&created_at=lt.${encodeURIComponent(cutoff)}` +
                `&order=created_at.asc&limit=${MAX_RESCUE}`
            );

            summary.rescue.checked = stale.length;

            for (const booking of stale) {
                try {
                    const response = await fetch(
                        'https://api.sumup.com/v0.1/checkouts?checkout_reference=' +
                        encodeURIComponent(booking.booking_reference),
                        { headers: { Authorization: `Bearer ${SUMUP_API_KEY}` } }
                    );

                    if (!response.ok) { summary.rescue.errors++; continue; }

                    const checkouts = await response.json();
                    const paid = Array.isArray(checkouts) ? checkouts.find(c => c.status === 'PAID') : null;

                    if (!paid) { summary.rescue.stillUnpaid++; continue; }

                    // Same amount guard as the live verifier
                    if (Number(paid.amount) + 0.001 < Number(booking.amount)) {
                        console.error('reconcile: amount mismatch on', booking.booking_reference);
                        summary.rescue.errors++;
                        continue;
                    }

                    await sbRpc('confirm_paid_booking', {
                        p_reference: booking.booking_reference,
                        p_transaction_id: paid.transaction_id || paid.transactions?.[0]?.id || null
                    });

                    summary.rescue.rescued++;
                    summary.rescue.references.push(booking.booking_reference);
                    console.log('reconcile: rescued paid booking', booking.booking_reference);

                } catch (err) {
                    console.error('reconcile: rescue failed for', booking.booking_reference, err.message);
                    summary.rescue.errors++;
                }
            }
        } catch (err) {
            console.error('reconcile: rescue sweep failed', err.message);
            summary.rescue.errors++;
        }
    }

    /* =====================================================================
       2. Send any confirmation that has not gone out
       ===================================================================== */
    if (emailConfigured()) {
        try {
            const pending = await sbSelect(
                'bookings?select=booking_reference,customer_email,confirmation_attempts' +
                '&status=eq.confirmed&confirmation_sent_at=is.null' +
                `&order=created_at.asc&limit=${MAX_EMAILS}`
            );

            summary.emails.pending = pending.length;

            for (const booking of pending) {
                if (!isRealAddress(booking.customer_email)) { summary.emails.skipped++; continue; }

                // Give up after 8 tries so one dead address can't hog every run.
                if (booking.confirmation_attempts >= 8) { summary.emails.skipped++; continue; }

                const result = await sendConfirmationFor(booking.booking_reference, { kind: 'retry', url });
                if (result.sent)         summary.emails.sent++;
                else if (result.skipped) summary.emails.skipped++;
                else                     summary.emails.failed++;
            }
        } catch (err) {
            console.error('reconcile: email sweep failed', err.message);
            summary.emails.failed++;
        }
    }

    summary.tookMs = Date.now() - started;
    console.log('reconcile summary', JSON.stringify(summary));
    return summary;
}
