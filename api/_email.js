// Email delivery.
//
// Two providers, tried in order. If Resend is having a bad morning, Brevo
// picks it up. Configure one or both — with both set, a single provider
// outage can't stop confirmations going out.
//
// Everything here throws on failure so the caller can log it and let the
// reconciler retry. A booking is never lost because an email bounced.

import { SHOW, formatPerformanceDate, to24, accessLabels } from './_show.js';

/* Environment values arrive verbatim. A line copied out of .env.example keeps
   its surrounding quotes, and `"Mamma Mia! <tickets@example.ie>"` is then not an
   address any provider will accept — it comes back as an opaque 422. Strip one
   layer of wrapping quotes from everything, including the keys. */
const unquote = v => String(v ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
const env = name => unquote(process.env[name]);

const RESEND_KEY = env('RESEND_API_KEY');
const BREVO_KEY  = env('BREVO_API_KEY');

const FROM     = env('EMAIL_FROM');       // "Mamma Mia! <tickets@yourdomain.ie>"
const REPLY_TO = env('EMAIL_REPLY_TO');
const BCC      = env('EMAIL_BCC');        // office copy, optional

const TIMEOUT_MS = 12000;

export function emailConfigured() {
    return Boolean(FROM && (RESEND_KEY || BREVO_KEY));
}

export function configuredProviders() {
    return [RESEND_KEY && 'resend', BREVO_KEY && 'brevo'].filter(Boolean);
}

/* -------------------------------------------------------------- addresses */

/* Deliberately stricter than the check on the form: this one has to match what
   the providers accept, because everything they refuse arrives back as a 422
   with no indication of which field was at fault. */
const ADDRESS_RE =
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** 'Mamma Mia! <tickets@x.ie>' -> { name, email }. null if it is not usable. */
export function parseAddress(value) {
    const raw = unquote(value);
    if (!raw) return null;
    const m = /^([\s\S]*?)\s*<\s*([^<>]+?)\s*>$/.exec(raw);
    const email = (m ? m[2] : raw).trim();
    if (!ADDRESS_RE.test(email)) return null;
    return { name: m ? unquote(m[1]) : '', email };
}

/** Back to a header value. The display name is quoted unless it is plain, so
    'Mamma Mia!' cannot be mistaken for the start of a second address. */
export function formatAddress(addr) {
    if (!addr) return '';
    if (!addr.name) return addr.email;
    const name = /^[A-Za-z0-9 ]+$/.test(addr.name)
        ? addr.name
        : '"' + addr.name.replace(/["\\]/g, '') + '"';
    return `${name} <${addr.email}>`;
}

/** One address, a comma-separated list, or an array. Unusable entries drop out. */
export function parseAddressList(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(',');
    return items.map(parseAddress).filter(Boolean);
}

/** 'tickets@yourdomain.ie' -> 't****s@yourdomain.ie', for diagnostics. */
export function maskAddress(value) {
    const addr = parseAddress(value);
    if (!addr) return null;
    const [user, domain] = addr.email.split('@');
    const masked = user.length < 3
        ? user[0] + '*'
        : user[0] + '*'.repeat(Math.min(user.length - 2, 6)) + user.slice(-1);
    return `${masked}@${domain}`;
}

/**
 * What is wrong with the email settings, in words, or null if they look usable.
 * Never includes a key or a full address — safe to show an administrator.
 */
export function emailConfigProblem() {
    if (!FROM) {
        return 'EMAIL_FROM is not set.';
    }
    if (!parseAddress(FROM)) {
        return 'EMAIL_FROM is not a usable address. Expected  Mamma Mia! <tickets@yourdomain.ie>  ' +
               'with no quotes around the whole value.';
    }
    if (!RESEND_KEY && !BREVO_KEY) {
        return 'No provider key. Set RESEND_API_KEY and/or BREVO_API_KEY.';
    }
    if (REPLY_TO && !parseAddress(REPLY_TO)) {
        return 'EMAIL_REPLY_TO is set but is not a usable address.';
    }
    if (BCC && !parseAddress(BCC)) {
        return 'EMAIL_BCC is set but is not a usable address.';
    }
    return null;
}

/* ----------------------------------------------------------------- errors */

/* kind 'config' means the settings are wrong and trying again will fail the
   same way; 'provider' means the provider was unreachable or unhappy and a
   retry is worth having. */
function emailError(message, extra = {}) {
    return Object.assign(new Error(message), { kind: 'provider', ...extra });
}

function providerError(label, status, raw) {
    let detail = raw;
    try {
        const parsed = JSON.parse(raw);
        detail = [parsed.name || parsed.code, parsed.message].filter(Boolean).join(': ') || raw;
    } catch { /* not JSON — keep the raw body */ }
    return emailError(`${label} ${status}: ${String(detail).trim().slice(0, 400)}`, { status });
}

/* ---------------------------------------------------------------- helpers */

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms))
    ]);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Turn a message into parsed, provider-ready addresses, or throw saying exactly
 * which setting is wrong. Everything the providers see has been through here,
 * so a 422 back from them is now genuinely surprising rather than routine.
 */
function buildEnvelope(message) {
    const problem = emailConfigProblem();
    if (problem) throw emailError(problem, { kind: 'config' });

    const to = parseAddressList(message.to);
    if (!to.length) {
        throw emailError('No usable recipient address: ' + JSON.stringify(message.to), { kind: 'config' });
    }

    /* A Reply-To we cannot use is dropped, never fatal: losing the address to
       answer on is better than losing the message. */
    const replyToSource = message.replyTo || REPLY_TO;
    const replyTo = parseAddress(replyToSource);
    if (replyToSource && !replyTo) console.warn('email: ignoring an unusable reply-to address');

    return {
        from: parseAddress(FROM),
        to,
        replyTo,
        bcc: message.bcc === false ? [] : parseAddressList(BCC),
        subject: String(message.subject ?? '').replace(/[\r\n]+/g, ' ').trim() || SHOW.name,
        html: message.html,
        text: message.text,
        attachments: message.attachments || []
    };
}

/* -------------------------------------------------------------- providers */

async function sendViaResend(envelope) {
    const body = {
        from: formatAddress(envelope.from),
        to: envelope.to.map(a => a.email),
        subject: envelope.subject,
        html: envelope.html,
        text: envelope.text
    };
    if (envelope.replyTo) body.reply_to = [envelope.replyTo.email];
    if (envelope.bcc.length) body.bcc = envelope.bcc.map(a => a.email);
    if (envelope.attachments.length) {
        body.attachments = envelope.attachments.map(a => ({
            filename: a.filename,
            content: a.contentBase64
        }));
    }

    const res = await withTimeout(fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }), TIMEOUT_MS, 'Resend');

    const raw = await res.text();
    if (!res.ok) throw providerError('Resend', res.status, raw);

    let id = null;
    try { id = JSON.parse(raw).id; } catch { /* fine */ }
    return { provider: 'resend', id };
}

async function sendViaBrevo(envelope) {
    const body = {
        sender: envelope.from.name
            ? { email: envelope.from.email, name: envelope.from.name }
            : { email: envelope.from.email },
        to: envelope.to.map(a => ({ email: a.email })),
        subject: envelope.subject,
        htmlContent: envelope.html,
        textContent: envelope.text
    };
    if (envelope.replyTo) body.replyTo = { email: envelope.replyTo.email };
    if (envelope.bcc.length) body.bcc = envelope.bcc.map(a => ({ email: a.email }));
    if (envelope.attachments.length) {
        body.attachment = envelope.attachments.map(a => ({ name: a.filename, content: a.contentBase64 }));
    }

    const res = await withTimeout(fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
    }), TIMEOUT_MS, 'Brevo');

    const raw = await res.text();
    if (!res.ok) throw providerError('Brevo', res.status, raw);

    let id = null;
    try { id = JSON.parse(raw).messageId; } catch { /* fine */ }
    return { provider: 'brevo', id };
}

/**
 * Send one email. Tries every configured provider before giving up.
 * Optional per-message `replyTo` overrides EMAIL_REPLY_TO; `bcc: false`
 * skips the EMAIL_BCC office copy.
 *
 * Throws with every provider's own words joined, and with `kind` set to
 * 'config' when the settings are at fault, so a caller can tell a passing
 * outage from something that will fail identically every time.
 */
export async function sendEmail(message) {
    const envelope = buildEnvelope(message);

    const attempts = [];
    for (const [name, fn] of [['resend', RESEND_KEY && sendViaResend], ['brevo', BREVO_KEY && sendViaBrevo]]) {
        if (!fn) continue;
        try {
            return await fn(envelope);
        } catch (err) {
            console.error(`email via ${name} failed:`, err.message);
            attempts.push({ provider: name, status: err.status ?? null, message: err.message });
        }
    }

    if (!attempts.length) {
        throw emailError('No email provider configured (set RESEND_API_KEY and/or BREVO_API_KEY)', { kind: 'config' });
    }

    /* Every provider answering with a 4xx that is not a rate limit means the
       request itself is wrong — the settings, not the weather. */
    const config = attempts.every(a => a.status >= 400 && a.status < 500 && a.status !== 429);
    throw emailError(attempts.map(a => a.message).join(' | '), {
        kind: config ? 'config' : 'provider',
        attempts
    });
}

/* --------------------------------------------------------------- calendar */

function icsAttachment(booking, dateLabel, url) {
    const start = new Date(booking.performance_date + 'T' + to24(SHOW.curtain) + ':00');
    if (isNaN(start)) return null;
    const end = new Date(start.getTime() + 2.5 * 3600 * 1000);
    const stamp = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//St Marys Edenderry//Mamma Mia//EN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:' + booking.booking_reference + '@stmarysedenderry',
        'DTSTAMP:' + stamp(new Date()),
        'DTSTART:' + stamp(start),
        'DTEND:' + stamp(end),
        'SUMMARY:' + SHOW.name + ' — ' + SHOW.school,
        'LOCATION:' + SHOW.venue,
        'DESCRIPTION:Booking ' + booking.booking_reference + ' — ' + booking.quantity +
            ' ticket(s). Doors ' + SHOW.doors + '.' + (url ? ' ' + url : ''),
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');

    return {
        filename: 'mamma-mia.ics',
        contentBase64: Buffer.from(ics, 'utf8').toString('base64')
    };
}

/* --------------------------------------------------------------- template */

/**
 * The confirmation. Table-based with inline styles, because Outlook is still
 * out there. Plain-text alternative included — a text part measurably helps
 * you stay out of the spam folder.
 */
export function buildConfirmation(booking, { performanceLabel, url } = {}) {
    const dateLabel = formatPerformanceDate(booking.performance_date, performanceLabel);
    const qty = booking.quantity + (booking.quantity === 1 ? ' ticket' : ' tickets');
    const paid = '€' + Number(booking.amount).toFixed(2).replace(/\.00$/, '');
    const ref = booking.booking_reference;
    const isCash = booking.payment_status === 'cash';
    const isComp = booking.payment_status === 'refunded';

    const paidLine = isComp ? 'Complimentary' : isCash ? paid + ' (paid in cash)' : paid + ' (paid by card)';

    // What they asked for at booking, echoed back so a mistake can be
    // corrected while there is still time to arrange the seats.
    const accessParts = accessLabels(booking.access_needs);
    if (booking.access_notes) accessParts.push(String(booking.access_notes).trim());
    const accessLine = accessParts.join(' · ');

    const subject = `Your tickets — ${SHOW.name}, ${dateLabel} [${ref}]`;

    const text = [
        `${SHOW.name.toUpperCase()} — ${SHOW.school}`,
        'BOOKING CONFIRMED',
        '',
        `Hello ${booking.customer_name},`,
        '',
        'Your booking is confirmed and paid for. Here are the details:',
        '',
        `  Booking reference : ${ref}`,
        `  Performance       : ${dateLabel}`,
        `  Doors / curtain   : ${SHOW.doors} / ${SHOW.curtain}`,
        `  Tickets           : ${qty}`,
        `  Paid              : ${paidLine}`,
        `  Venue             : ${SHOW.venue}`,
        ...(accessLine ? [`  Access            : ${accessLine}`] : []),
        '',
        ...(accessLine ? [
            'Seats will be kept for you. If any of that is wrong, reply to this',
            'email and we will put it right.',
            ''
        ] : []),
        'ON THE NIGHT',
        'There is no ticket to print. Give your name at the door and we will',
        'find you on the list. Bring the reference above if you have it.',
        'Doors open at ' + SHOW.doors + ' — please be seated by ' + SHOW.curtain + '.',
        '',
        url ? 'Booking details: ' + url + '/success.html?ref=' + encodeURIComponent(ref) : '',
        '',
        'Questions, or need to change something? Reply to this email' +
            (url ? ' or use the contact form: ' + url + '/contact.html?topic=booking&ref=' + encodeURIComponent(ref) : '') +
            ', quoting ' + ref + '.',
        '',
        'See you there.',
        SHOW.school,
        '',
        'Mamma Mia! is presented through special arrangement with Music Theatre',
        'International (MTI). All authorized performance materials are also supplied',
        'by MTI. 423 West 55th Street, New York, NY 10019.',
        '',
        'The videotaping or other video or audio recording of this production is',
        'strictly prohibited.'
    ].filter(l => l !== undefined).join('\n');

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#fbf9f5;font-family:Helvetica,Arial,sans-serif;color:#22333f;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Booking ${esc(ref)} confirmed — ${esc(qty)} for ${esc(dateLabel)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbf9f5;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e2eaef;border-radius:4px;">

  <!-- Aegean rule -->
  <tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td width="70%" height="3" style="background:#1b6ca8;font-size:0;line-height:0;">&nbsp;</td>
        <td width="15%" height="3" style="background:#e0a020;font-size:0;line-height:0;">&nbsp;</td>
        <td width="15%" height="3" style="background:#c2356b;font-size:0;line-height:0;">&nbsp;</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:34px 32px 26px;text-align:center;">
    <div style="font-size:11px;letter-spacing:2px;color:#5b6f7c;text-transform:uppercase;">${esc(SHOW.school)}</div>
    <div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:36px;line-height:1.15;color:#1b6ca8;padding-top:10px;">${esc(SHOW.name)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:20px auto 0;">
      <tr><td style="background:#f1f5ea;border:1px solid #dde6d0;border-radius:3px;padding:7px 18px;
                     font-size:11px;letter-spacing:2px;color:#4d6435;text-transform:uppercase;">
        Booking confirmed
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td height="1" style="background:#e2eaef;font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:26px 32px 4px;">
    <p style="margin:0 0 14px;font-family:Georgia,'Times New Roman',Times,serif;font-size:19px;color:#22333f;">Hello ${esc(booking.customer_name)},</p>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#5b6f7c;">
      Your booking is confirmed and paid for. Everything you need is below —
      keep this email, or simply give your name at the door.
    </p>
  </td></tr>

  <tr><td style="padding:0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#f4f8fa;border:1px solid #cbdae3;border-radius:3px;">
      <tr><td style="padding:18px;text-align:center;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5b6f7c;">Booking reference</div>
        <div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:27px;letter-spacing:4px;color:#22333f;padding-top:8px;">${esc(ref)}</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 32px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:15px;color:#22333f;">
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;color:#5b6f7c;">Performance</td>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;text-align:right;">${esc(dateLabel)}</td>
      </tr>
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;color:#5b6f7c;">Doors / curtain</td>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;text-align:right;">${esc(SHOW.doors)} / ${esc(SHOW.curtain)}</td>
      </tr>
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;color:#5b6f7c;">Tickets</td>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;text-align:right;">${esc(qty)}</td>
      </tr>
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;color:#5b6f7c;">Paid</td>
        <td style="padding:11px 0;border-bottom:1px solid #e2eaef;text-align:right;">${esc(paidLine)}</td>
      </tr>
      <tr>
        <td style="padding:11px 0;${accessLine ? 'border-bottom:1px solid #e2eaef;' : ''}color:#5b6f7c;vertical-align:top;">Venue</td>
        <td style="padding:11px 0;${accessLine ? 'border-bottom:1px solid #e2eaef;' : ''}text-align:right;">${esc(SHOW.venue)}</td>
      </tr>
      ${accessLine ? `<tr>
        <td style="padding:11px 0;color:#5b6f7c;vertical-align:top;">Access</td>
        <td style="padding:11px 0;text-align:right;">${esc(accessLine)}</td>
      </tr>` : ''}
    </table>
  </td></tr>

  <tr><td style="padding:22px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#fdfaf3;border:1px solid #ecdfc4;border-radius:3px;">
      <tr><td style="padding:16px 18px;font-size:14px;line-height:1.65;color:#22333f;">
        <span style="color:#8a6414;text-transform:uppercase;letter-spacing:2px;font-size:11px;">On the night</span><br>
        There is nothing to print. Give your name at the door and we will find you on the list.
        Doors open at ${esc(SHOW.doors)} — please be seated by ${esc(SHOW.curtain)}.${accessLine ? `
        <br><br>We have your access request and your seats will be kept for you. If anything above
        is wrong, reply to this email and we will put it right.` : ''}
      </td></tr>
    </table>
  </td></tr>

  ${url ? `<tr><td style="padding:26px 32px 0;text-align:center;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
      <tr><td style="background:#1b6ca8;border-radius:3px;">
        <a href="${esc(url)}/success.html?ref=${encodeURIComponent(ref)}"
           style="display:inline-block;color:#ffffff;text-decoration:none;padding:13px 30px;
                  font-size:15px;letter-spacing:1px;
                  font-family:Helvetica,Arial,sans-serif;">View your booking</a>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <tr><td style="padding:26px 32px 28px;">
    <p style="margin:0;font-size:13px;line-height:1.7;color:#5b6f7c;">
      Need to change something, or did something look wrong? Reply to this email${url ? ` or use our
      <a href="${esc(url)}/contact.html?topic=booking&amp;ref=${encodeURIComponent(ref)}" style="color:#c2356b;text-decoration:underline;">contact form</a>` : ''},
      quoting <span style="color:#22333f;">${esc(ref)}</span>.
    </p>
  </td></tr>

  <tr><td style="background:#f4f8fa;padding:20px 32px 22px;text-align:center;border-top:1px solid #e2eaef;">
    <p style="margin:0;font-family:Georgia,'Times New Roman',Times,serif;font-size:14px;color:#22333f;">${esc(SHOW.school)}</p>
    <p style="margin:10px 0 0;font-size:11px;line-height:1.6;color:#5b6f7c;">
      Mamma Mia! is presented through special arrangement with Music Theatre International (MTI).
      All authorized performance materials are also supplied by MTI.
      423 West 55th Street, New York, NY 10019.
    </p>
    <p style="margin:8px 0 0;font-size:11px;line-height:1.6;color:#5b6f7c;">
      The videotaping or other video or audio recording of this production is strictly prohibited.
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

    const ics = icsAttachment(booking, dateLabel, url);

    return {
        to: booking.customer_email,
        subject,
        html,
        text,
        attachments: ics ? [ics] : []
    };
}
