// One place that knows how to send a booking confirmation.
//
// Used by three callers — the payment verifier, the scheduled reconciler and
// the admin resend button — so the "has this already gone out?" rule lives in
// exactly one spot.

import { sbSelect, sbRpc } from './_supabase.js';
import { sendEmail, buildConfirmation, emailConfigured } from './_email.js';

// Door sales without a real address get this placeholder — never email it.
const PLACEHOLDER = /@stmarys\.local$/i;
const VALID = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isRealAddress(email) {
    return Boolean(email) && VALID.test(email) && !PLACEHOLDER.test(email);
}

/**
 * Send the confirmation for one booking.
 *
 * Never throws — returns a small result object the caller can log or count.
 *   { sent: true,  provider, id }
 *   { sent: false, skipped: 'reason' }        nothing was attempted
 *   { sent: false, error: 'why' }             attempted and failed, will retry
 */
export async function sendConfirmationFor(reference, { force = false, kind = 'confirmation', url = '' } = {}) {
    if (!emailConfigured()) {
        return { sent: false, skipped: 'email not configured' };
    }

    /* --- look before claiming, so a door sale never burns an attempt --- */
    const [booking] = await sbSelect(
        `bookings?select=*&booking_reference=eq.${encodeURIComponent(reference)}&limit=1`
    );

    if (!booking)                       return { sent: false, skipped: 'booking not found' };
    if (booking.status !== 'confirmed') return { sent: false, skipped: 'booking not confirmed' };
    if (!isRealAddress(booking.customer_email)) {
        return { sent: false, skipped: 'no email address on this booking' };
    }
    if (booking.confirmation_sent_at && !force) {
        return { sent: false, skipped: 'already sent' };
    }

    /* --- claim it: exactly one caller gets to send --- */
    let claimed;
    try {
        claimed = await sbRpc('claim_confirmation_email', {
            p_reference: reference,
            p_force: force
        });
    } catch (err) {
        console.error('claim failed for', reference, err.message);
        return { sent: false, error: 'could not claim: ' + err.message };
    }

    if (!claimed || !claimed.booking_reference) {
        return { sent: false, skipped: 'another send is already in flight' };
    }

    /* --- the night's proper label, e.g. "Wednesday 27th January 2027" --- */
    let performanceLabel = null;
    try {
        const [perf] = await sbSelect(
            `performances?select=label&key=eq.${encodeURIComponent(claimed.performance_date)}&limit=1`
        );
        performanceLabel = perf?.label || null;
    } catch { /* the template can derive it from the date */ }

    /* --- send --- */
    try {
        const message = buildConfirmation(claimed, { performanceLabel, url });
        const result = await sendEmail(message);

        await sbRpc('record_email_result', {
            p_reference: reference,
            p_to: claimed.customer_email,
            p_kind: kind,
            p_ok: true,
            p_provider: result.provider,
            p_provider_id: result.id,
            p_error: null
        }).catch(e => console.error('could not log send', e.message));

        return { sent: true, provider: result.provider, id: result.id };

    } catch (err) {
        console.error('confirmation send failed for', reference, err.message);

        await sbRpc('record_email_result', {
            p_reference: reference,
            p_to: claimed.customer_email,
            p_kind: kind,
            p_ok: false,
            p_provider: null,
            p_provider_id: null,
            p_error: err.message
        }).catch(e => console.error('could not log failure', e.message));

        return { sent: false, error: err.message };
    }
}
