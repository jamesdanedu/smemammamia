// Access requests: the two emails each one sends.
//
// Used by /api/access-request when the request comes in, and by the
// reconciler to retry anything that did not go. Each email is claimed in the
// database before it is sent — a conditional update that only one caller can
// win — so a retry racing the original never sends anybody the same email
// twice. A failed send hands its claim back for the next sweep.

import { sbSelect, sbRpc } from './_supabase.js';
import { sendEmail, emailConfigured, buildAccessRequestForTeam, buildAccessRequestAck, parseAddressList } from './_email.js';
import { ACCESS_REQUESTS_TO, DEFAULT_ENQUIRIES_TO } from './_show.js';

const enc = encodeURIComponent;

/** Where requests go: ACCESS_REQUESTS_TO, else ENQUIRIES_TO, else the default inbox. */
export function accessTeamAddresses() {
    const list = parseAddressList(ACCESS_REQUESTS_TO);
    return (list.length ? list : parseAddressList(DEFAULT_ENQUIRIES_TO)).map(a => a.email);
}

/**
 * Claim one of the two emails on a request (claim_access_email, in
 * schema-seating.sql). True if this caller won: not sent yet, and nobody else
 * mid-send — a claim older than ten minutes is a send that died.
 */
async function claim(id, kind) {
    return (await sbRpc('claim_access_email', { p_id: id, p_kind: kind })) === true;
}

async function sendOne(request, kind, message) {
    if (!(await claim(request.id, kind))) return { skipped: 'already sent or in flight' };
    try {
        const sent = await sendEmail(message);
        await sbRpc('claim_access_email', { p_id: request.id, p_kind: kind, p_sent: true })
            .catch(e => console.error('could not record access email', e.message));
        return { sent: true, provider: sent.provider };
    } catch (err) {
        console.error(`access request ${request.reference}: ${kind} email failed`, err.message);
        // hand the claim back so the reconciler tries again
        await sbRpc('claim_access_email', { p_id: request.id, p_kind: kind, p_release: true }).catch(() => {});
        return { sent: false, error: err.message };
    }
}

/** Send whichever of the two emails has not gone yet. Never throws. */
export async function sendAccessEmails(request, { url = '' } = {}) {
    if (!emailConfigured()) return { team: { skipped: 'email not configured' }, ack: { skipped: 'email not configured' } };

    let performanceLabel = null;
    try {
        const [perf] = await sbSelect(`performances?select=label&key=eq.${enc(request.performance_date)}&limit=1`);
        performanceLabel = perf?.label || null;
    } catch { /* the template can work it out from the date */ }

    const out = {};
    out.team = request.team_emailed_at
        ? { skipped: 'already sent' }
        : await sendOne(request, 'team',
            buildAccessRequestForTeam(request, { to: accessTeamAddresses(), performanceLabel, url }));
    out.ack = request.ack_emailed_at
        ? { skipped: 'already sent' }
        : await sendOne(request, 'ack', buildAccessRequestAck(request, { performanceLabel }));
    return out;
}
