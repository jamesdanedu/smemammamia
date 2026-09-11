// Email delivery.
//
// Two providers, tried in order. If Resend is having a bad morning, Brevo
// picks it up. Configure one or both — with both set, a single provider
// outage can't stop confirmations going out.
//
// Everything here throws on failure so the caller can log it and let the
// reconciler retry. A booking is never lost because an email bounced.

import { SHOW, formatPerformanceDate, to24 } from './_show.js';

const RESEND_KEY = process.env.RESEND_API_KEY;
const BREVO_KEY  = process.env.BREVO_API_KEY;

const FROM     = process.env.EMAIL_FROM      || '';   // "Mamma Mia! <tickets@yourdomain.ie>"
const REPLY_TO = process.env.EMAIL_REPLY_TO  || '';
const BCC      = process.env.EMAIL_BCC       || '';   // office copy, optional

const TIMEOUT_MS = 12000;

export function emailConfigured() {
    return Boolean(FROM && (RESEND_KEY || BREVO_KEY));
}

export function configuredProviders() {
    return [RESEND_KEY && 'resend', BREVO_KEY && 'brevo'].filter(Boolean);
}

/* ---------------------------------------------------------------- helpers */

function parseFrom(value) {
    const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value);
    return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] }
             : { name: '', email: String(value).trim() };
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms))
    ]);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* -------------------------------------------------------------- providers */

async function sendViaResend({ to, subject, html, text, attachments, replyTo, bcc }) {
    const body = {
        from: FROM,
        to: [to],
        subject,
        html,
        text
    };
    const rt = replyTo || REPLY_TO;
    if (rt) body.reply_to = rt;
    if (BCC && bcc !== false) body.bcc = [BCC];
    if (attachments?.length) {
        body.attachments = attachments.map(a => ({
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
    if (!res.ok) throw new Error(`Resend ${res.status}: ${raw.slice(0, 300)}`);

    let id = null;
    try { id = JSON.parse(raw).id; } catch { /* fine */ }
    return { provider: 'resend', id };
}

async function sendViaBrevo({ to, subject, html, text, attachments, replyTo, bcc }) {
    const sender = parseFrom(FROM);
    const body = {
        sender: { email: sender.email, name: sender.name || undefined },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text
    };
    const rt = replyTo || REPLY_TO;
    if (rt) body.replyTo = { email: rt };
    if (BCC && bcc !== false) body.bcc = [{ email: BCC }];
    if (attachments?.length) {
        body.attachment = attachments.map(a => ({ name: a.filename, content: a.contentBase64 }));
    }

    const res = await withTimeout(fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
    }), TIMEOUT_MS, 'Brevo');

    const raw = await res.text();
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${raw.slice(0, 300)}`);

    let id = null;
    try { id = JSON.parse(raw).messageId; } catch { /* fine */ }
    return { provider: 'brevo', id };
}

/**
 * Send one email. Tries every configured provider before giving up.
 * Optional per-message `replyTo` overrides EMAIL_REPLY_TO; `bcc: false`
 * skips the EMAIL_BCC office copy.
 * Throws with all provider errors joined if none succeed.
 */
export async function sendEmail(message) {
    if (!emailConfigured()) throw new Error('Email is not configured (need EMAIL_FROM and a provider key)');
    if (!message.to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(message.to)) {
        throw new Error('No usable email address: ' + message.to);
    }

    const attempts = [];
    for (const [name, fn] of [['resend', RESEND_KEY && sendViaResend], ['brevo', BREVO_KEY && sendViaBrevo]]) {
        if (!fn) continue;
        try {
            return await fn(message);
        } catch (err) {
            console.error(`email via ${name} failed:`, err.message);
            attempts.push(`${name}: ${err.message}`);
        }
    }
    throw new Error(attempts.join(' | ') || 'No email provider configured');
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
        '',
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
        <td style="padding:11px 0;color:#5b6f7c;vertical-align:top;">Venue</td>
        <td style="padding:11px 0;text-align:right;">${esc(SHOW.venue)}</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:22px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#fdfaf3;border:1px solid #ecdfc4;border-radius:3px;">
      <tr><td style="padding:16px 18px;font-size:14px;line-height:1.65;color:#22333f;">
        <span style="color:#8a6414;text-transform:uppercase;letter-spacing:2px;font-size:11px;">On the night</span><br>
        There is nothing to print. Give your name at the door and we will find you on the list.
        Doors open at ${esc(SHOW.doors)} — please be seated by ${esc(SHOW.curtain)}.
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
