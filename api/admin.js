// POST /api/admin  { password, action, ... }
//
// Every admin read and write happens here, behind ADMIN_PASSWORD.
// Customer details never leave this function without the password.

import crypto from 'node:crypto';
import {
    applyCors, requireMethod, readBody,
    sbSelect, sbSelectAll, sbUpdate, sbRpc, sbInsert, newBookingRef, supabaseConfigured
} from './_supabase.js';
import { sendConfirmationFor } from './_confirmations.js';
import {
    emailConfigured, configuredProviders, emailConfigProblem,
    maskAddress, parseAddressList, sendEmail
} from './_email.js';
import { runReconcile } from './reconcile.js';
import { openCheckout, baseUrlFor } from './_sumup.js';
import { siteUrl, SHOW, ENQUIRIES_TO, cleanAccessNeeds } from './_show.js';
import { accessTeamAddresses, sendAccessEmails } from './_access.js';
import { loadSeatState, countNight, seatRefusal } from './_seats.js';
import { cleanSeats, describeSeats, isAccessible, ACCESSIBLE_IDS, SEAT_MAP } from '../seating.js';

const TICKET_PRICE = Number(process.env.TICKET_PRICE || 10);
const MAX_STAFF_SEATS = 40;

const enc = encodeURIComponent;
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/* How a staff booking is paid for.

   card_door    "Card Swipe at SME Office": taken on the office card machine,
                not through the website. The site only records it, so it
                counts as paid at once and is kept apart from online sales.
                (The code is still card_door, from when it meant the door
                table, so bookings already stored keep their meaning.)
   card_online  "Card payment (online)": the website opens the same SumUp
                checkout the public booking page uses. The seats are held,
                not confirmed, until SumUp says it was paid. */
const STAFF_PAYMENTS = {
    cash:        { status: 'cash', method: 'cash',      free: false },
    card_door:   { status: 'paid', method: 'card_door', free: false },
    card_online: { status: 'unpaid', method: null,      free: false, online: true },
    comp:        { status: 'comp', method: 'comp',      free: true  }
};

// SumUp's hosted payment page lasts 30 minutes, so a hold made while somebody
// pays at the office, or on their phone from a link, lasts as long.
const STAFF_ONLINE_HOLD_MINUTES = 30;

const ACCESS_STATUSES = ['new', 'contacted', 'seated', 'closed'];

/** Flatten PostgREST's embedded booking_seats into a plain, sorted seat list. */
function withSeats(booking) {
    const seats = cleanSeats((booking.booking_seats || []).map(s => s.seat_id));
    return { ...booking, seats, seatsLabel: describeSeats(seats) };
}

/** A refusal from one of the seat functions, as a message staff can act on. */
function seatProblem(err) {
    const refused = seatRefusal(err.pgMessage || err.message);
    if (!refused) return null;
    return refused.kind === 'taken'
        ? `Already taken: ${refused.seats.join(', ')}. Pick again.`
        : `Not on sale: ${refused.seats.join(', ')}.`;
}

function passwordOk(supplied) {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return false;
    const a = Buffer.from(String(supplied || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        // still burn a comparison so timing doesn't leak the length
        crypto.timingSafeEqual(b, b);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'POST')) return;

    const body = readBody(req);

    if (!passwordOk(body.password)) {
        await new Promise(r => setTimeout(r, 400)); // slow down guessing
        return res.status(401).json({ error: 'Incorrect password' });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Database not configured' });
    }

    try {
        switch (body.action) {

            /* ---------------- overview ---------------- */
            case 'summary': {
                const [perfs, bookings, requests] = await Promise.all([
                    sbSelect('performances?select=key,label,on_sale&order=key.asc'),
                    sbSelectAll('bookings?select=booking_reference,performance_date,quantity,amount,status,' +
                             'payment_status,payment_method,booked_by,customer_name,confirmation_sent_at,' +
                             'last_email_error,seat_conflict,seats_requested,access_needs,access_notes' +
                             '&status=eq.confirmed&order=created_at.asc'),
                    sbSelect('access_requests?select=id,reference,performance_date,name,wheelchair_spaces,' +
                             'companion_seats,status,team_emailed_at,ack_emailed_at,created_at&order=created_at.asc')
                ]);

                // Seats per night, one request each (Supabase caps a request at 1,000 rows)
                const states = await Promise.all(perfs.map(p => loadSeatState(p.key)));
                const performances = perfs.map((p, i) => ({ ...p, ...countNight(states[i]) }));

                const confirmed = bookings.filter(b => b.status === 'confirmed');
                const tickets = pred => confirmed.filter(pred).reduce((t, b) => t + b.quantity, 0);
                const isComp = b => b.payment_status === 'comp' || b.payment_status === 'refunded';

                const revenue = confirmed
                    .filter(b => ['paid', 'cash'].includes(b.payment_status))
                    .reduce((t, b) => t + Number(b.amount), 0);

                const bySeller = {};
                for (const b of confirmed) {
                    const who = b.booked_by || 'WEB';
                    bySeller[who] = (bySeller[who] || 0) + b.quantity;
                }

                const compByNight = {};
                for (const b of confirmed.filter(isComp)) {
                    compByNight[b.performance_date] = (compByNight[b.performance_date] || 0) + b.quantity;
                }

                // Access needs ticked on ordinary bookings, so the office can
                // plan before the night rather than discover it at the door.
                const needsAccess = b => Boolean(b.access_needs || b.access_notes);
                const accessByNight = {};
                for (const b of confirmed.filter(needsAccess)) {
                    const night = (accessByNight[b.performance_date] ||= { bookings: 0, tickets: 0 });
                    night.bookings += 1;
                    night.tickets  += b.quantity;
                }

                const open = requests.filter(r => r.status === 'new' || r.status === 'contacted');

                return res.status(200).json({
                    performances,
                    totals: {
                        bookings: confirmed.length,
                        tickets: tickets(() => true),
                        revenue: Number(revenue.toFixed(2)),
                        onlineTickets:  tickets(b => b.payment_method === 'sumup' && b.payment_status === 'paid'),
                        cashTickets:    tickets(b => b.payment_status === 'cash'),
                        cardDoorTickets: tickets(b => b.payment_method === 'card_door'),
                        compTickets:    tickets(isComp),
                        compByNight
                    },
                    bySeller,
                    email: {
                        configured: emailConfigured(),
                        providers: configuredProviders(),
                        pending: confirmed.filter(b => !b.confirmation_sent_at).length,
                        failing: confirmed.filter(b => !b.confirmation_sent_at && b.last_email_error).length
                    },
                    // paid, but the seats went while the customer was away
                    seatConflicts: confirmed.filter(b => b.seat_conflict).map(b => ({
                        reference: b.booking_reference,
                        performanceDate: b.performance_date,
                        name: b.customer_name,
                        quantity: b.quantity,
                        wanted: cleanSeats(b.seats_requested || [])
                    })),
                    accessRequests: {
                        open: open.length,
                        byStatus: Object.fromEntries(ACCESS_STATUSES.map(s => [s, requests.filter(r => r.status === s).length])),
                        unsentEmails: requests.filter(r => !r.team_emailed_at || !r.ack_emailed_at).length,
                        openList: open
                    },
                    access: {
                        bookings: confirmed.filter(needsAccess).length,
                        tickets: tickets(needsAccess),
                        byNight: accessByNight
                    }
                });
            }

            /* ---------------- booking list ---------------- */
            case 'list': {
                const filters = ['select=*,booking_seats(seat_id)', 'order=created_at.desc'];
                if (body.performanceDate) filters.push(`performance_date=eq.${enc(body.performanceDate)}`);
                if (body.status)          filters.push(`status=eq.${enc(body.status)}`);
                const rows = await sbSelectAll('bookings?' + filters.join('&'));
                return res.status(200).json({ bookings: rows.map(withSeats) });
            }

            /* ---------------- door list ---------------- */
            case 'door-list': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'performanceDate required' });
                const rows = await sbSelectAll(
                    'bookings?select=booking_reference,customer_name,quantity,booked_by,payment_status,payment_method,' +
                    'seat_conflict,access_needs,access_notes,booking_seats(seat_id)' +
                    `&performance_date=eq.${enc(body.performanceDate)}` +
                    '&status=eq.confirmed&order=customer_name.asc'
                );
                return res.status(200).json({ bookings: rows.map(withSeats) });
            }

            /* ---------------- tonight's seats ----------------
               Who is in which seat, what is blocked and what is released —
               for the printed plan, for picking seats by hand, and for the
               block / release switches. */
            case 'seat-map': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'performanceDate required' });
                const state = await loadSeatState(body.performanceDate);
                return res.status(200).json({
                    date: body.performanceDate,
                    taken: state.taken,
                    blocks: state.blocks,
                    released: state.releases.map(r => r.seat_id),
                    counts: countNight(state)
                });
            }

            /* ---------------- staff booking ----------------
               Staff pick the seats on the plan — any seat, accessible and
               blocked included. Cash, card swipe at the office and
               complimentary are confirmed on the spot. Card payment (online)
               holds the seats and opens a SumUp checkout; it is confirmed the
               way every online booking is, once SumUp says it was paid.
               Same hold function as the website, same lock, same refusal if
               somebody else has a seat. */
            case 'cash-booking':
            case 'staff-booking': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'Choose a performance.' });
                const name = String(body.customerName || '').trim();
                if (name.length < 2) return res.status(400).json({ error: 'Customer name is required.' });

                const asked = Array.isArray(body.seats) ? body.seats.length : 0;
                const seats = cleanSeats(body.seats);
                if (!seats.length) return res.status(400).json({ error: 'Pick the seats on the plan.' });
                if (seats.length !== asked) return res.status(400).json({ error: 'Some of those seats are not on the plan.' });
                if (seats.length > MAX_STAFF_SEATS) {
                    return res.status(400).json({ error: `No more than ${MAX_STAFF_SEATS} seats in one booking — split it up.` });
                }

                const payment = STAFF_PAYMENTS[body.payment] || (body.free ? STAFF_PAYMENTS.comp : STAFF_PAYMENTS.cash);
                const amount = payment.free ? 0 : Number((seats.length * TICKET_PRICE).toFixed(2));
                const reference = newBookingRef();

                let accessRequestId = null;
                if (body.accessRequestId) {
                    const [ar] = await sbSelect(`access_requests?select=id,performance_date&id=eq.${enc(body.accessRequestId)}&limit=1`);
                    if (!ar) return res.status(400).json({ error: 'That access request no longer exists.' });
                    if (ar.performance_date !== body.performanceDate) {
                        return res.status(400).json({ error: 'That access request is for a different night.' });
                    }
                    accessRequestId = ar.id;
                }

                let row;
                try {
                    row = await sbRpc('create_hold', {
                        p_reference:      reference,
                        p_date:           body.performanceDate,
                        p_seats:          seats,
                        p_amount:         amount,
                        p_name:           name,
                        p_email:          String(body.customerEmail || '').trim().toLowerCase() || 'door@stmarys.local',
                        p_phone:          String(body.customerPhone || '').trim(),
                        p_booked_by:      String(body.bookedBy || 'DOOR').trim().slice(0, 80),
                        p_access_needs:   cleanAccessNeeds(body.accessNeeds),
                        p_access_notes:   String(body.accessNotes || '').trim().slice(0, 300),
                        p_restricted:     ACCESSIBLE_IDS,
                        p_staff:          true,
                        p_confirm:        !payment.online,
                        p_hold_minutes:   STAFF_ONLINE_HOLD_MINUTES,
                        p_payment_status: payment.status,
                        p_payment_method: payment.method,
                        p_notes:          String(body.notes || '').trim().slice(0, 300),
                        p_access_request: accessRequestId
                    });
                } catch (err) {
                    const problem = seatProblem(err);
                    if (problem) return res.status(409).json({ error: problem });
                    const msg = err.pgMessage || err.message || '';
                    if (msg.includes('NOT_ON_SALE')) return res.status(409).json({ error: 'That night is closed for sale.' });
                    throw err;
                }

                // Card payment (online): open the SumUp checkout and hand the
                // link back. Nothing is confirmed or emailed yet — that happens
                // when the payment is verified, exactly as for the website.
                if (payment.online) {
                    const opened = await openCheckout({
                        reference,
                        amount,
                        quantity: seats.length,
                        performanceDate: body.performanceDate,
                        baseUrl: baseUrlFor(req)
                    });
                    if (!opened.ok) return res.status(opened.status).json({ error: opened.error });
                    return res.status(200).json({
                        booking: row,
                        seats,
                        seatsLabel: describeSeats(seats),
                        pending: true,
                        checkoutUrl: opened.checkoutUrl,
                        expiresAt: row?.held_until || null
                    });
                }

                // Staff bookings get a confirmation too, when an address was given.
                let emailResult = { sent: false, skipped: 'no email address' };
                try {
                    emailResult = await sendConfirmationFor(reference, { url: siteUrl(req) });
                } catch (err) {
                    console.error('staff booking confirmation failed', err.message);
                }

                return res.status(200).json({
                    booking: row,
                    seats,
                    seatsLabel: describeSeats(seats),
                    email: emailResult
                });
            }

            /* ---------------- move a booking to other seats ----------------
               Settles a seat conflict, or moves a party for any other reason.
               Send the customer their new seats with resend-confirmation. */
            case 'reseat': {
                if (!body.bookingRef) return res.status(400).json({ error: 'bookingRef required' });
                const seats = cleanSeats(body.seats);
                try {
                    const row = await sbRpc('reseat_booking', { p_reference: String(body.bookingRef), p_seats: seats });
                    return res.status(200).json({ booking: row, seats, seatsLabel: describeSeats(seats) });
                } catch (err) {
                    const problem = seatProblem(err);
                    if (problem) return res.status(409).json({ error: problem });
                    const msg = err.pgMessage || err.message || '';
                    if (msg.includes('SEAT_COUNT_MISMATCH')) {
                        return res.status(400).json({ error: 'Pick one seat for each ticket on the booking.' });
                    }
                    if (msg.includes('NOT_CONFIRMED')) return res.status(409).json({ error: 'Only confirmed bookings can be moved.' });
                    throw err;
                }
            }

            /* ---------------- cancel ----------------
               There are no refunds: a ticket that is not wanted can be passed
               on by its holder. Cancelling is for staff mistakes — a wrong
               night, a duplicate — and for anything paid online it has to be
               confirmed knowing that no money goes back. */
            case 'cancel': {
                if (!body.bookingRef) return res.status(400).json({ error: 'bookingRef required' });
                const [current] = await sbSelect(
                    `bookings?select=status,payment_method,payment_status&booking_reference=eq.${enc(body.bookingRef)}&limit=1`
                );
                if (!current) return res.status(404).json({ error: 'Booking not found' });

                const paidOnline = current.payment_method === 'sumup' && current.payment_status === 'paid';
                if (paidOnline && !body.confirmNoRefund) {
                    return res.status(409).json({
                        error: 'This booking was paid online. Cancelling it does not return any money — confirm to go ahead.',
                        needsConfirm: true
                    });
                }

                const [row] = await sbUpdate(
                    'bookings',
                    `booking_reference=eq.${enc(body.bookingRef)}`,
                    { status: 'cancelled', held_until: null, seat_conflict: false,
                      notes: String(body.reason || 'Cancelled by admin').slice(0, 300) }
                );

                // Put the seats back this second rather than waiting for the
                // next hold to sweep them.
                let seatsFreed = 0;
                try {
                    seatsFreed = await sbRpc('release_booking_seats', { p_reference: body.bookingRef }) || 0;
                } catch (err) {
                    console.error('could not release seats on cancel:', err.message);
                }

                return res.status(200).json({ booking: row, seatsFreed });
            }

            /* ---------------- block seats for a night ---------------- */
            case 'block-seats': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'performanceDate required' });
                const seats = cleanSeats(body.seats);
                if (!seats.length) return res.status(400).json({ error: 'Pick the seats on the plan.' });
                try {
                    const changed = await sbRpc('set_seat_blocks', {
                        p_date: body.performanceDate,
                        p_seats: seats,
                        p_blocked: body.blocked !== false,
                        p_note: String(body.note || '').trim().slice(0, 120)
                    });
                    return res.status(200).json({ changed, seats });
                } catch (err) {
                    const problem = seatProblem(err);
                    if (problem) return res.status(409).json({ error: problem.replace('Pick again.', 'Move or cancel that booking first.') });
                    throw err;
                }
            }

            /* ---------------- accessible seats on or off general sale ---------------- */
            case 'release-seats': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'performanceDate required' });
                const seats = cleanSeats(body.seats);
                if (!seats.length) return res.status(400).json({ error: 'Pick the accessible seats on the plan.' });
                const notAccessible = seats.filter(id => !isAccessible(id));
                if (notAccessible.length) {
                    return res.status(400).json({ error: `Not accessible seats: ${notAccessible.join(', ')}.` });
                }
                try {
                    const changed = await sbRpc('set_accessible_release', {
                        p_date: body.performanceDate,
                        p_seats: seats,
                        p_released: body.released !== false
                    });
                    return res.status(200).json({ changed, seats });
                } catch (err) {
                    const refused = seatRefusal(err.pgMessage || err.message);
                    if (refused) {
                        return res.status(409).json({
                            error: `Somebody has ${refused.seats.join(', ')} — they stay on sale until that booking is moved or cancelled.`
                        });
                    }
                    throw err;
                }
            }

            /* ---------------- access requests ---------------- */
            case 'access-requests': {
                const filters = ['select=*', 'order=created_at.desc', 'limit=500'];
                if (body.performanceDate) filters.push(`performance_date=eq.${enc(body.performanceDate)}`);
                if (ACCESS_STATUSES.includes(body.status)) filters.push(`status=eq.${enc(body.status)}`);
                const rows = await sbSelect('access_requests?' + filters.join('&'));
                return res.status(200).json({ requests: rows, team: accessTeamAddresses().map(maskAddress) });
            }

            case 'access-request-update': {
                if (!body.id) return res.status(400).json({ error: 'id required' });
                const patch = {};
                if (body.status !== undefined) {
                    if (!ACCESS_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Unknown status' });
                    patch.status = body.status;
                }
                if (body.staffNotes !== undefined) patch.staff_notes = String(body.staffNotes).slice(0, 1000) || null;
                if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
                const [row] = await sbUpdate('access_requests', `id=eq.${enc(body.id)}`, patch);
                return res.status(200).json({ request: row });
            }

            case 'access-request-resend': {
                if (!body.id) return res.status(400).json({ error: 'id required' });
                const [row] = await sbSelect(`access_requests?select=*&id=eq.${enc(body.id)}&limit=1`);
                if (!row) return res.status(404).json({ error: 'Request not found' });
                const result = await sendAccessEmails(row, { url: siteUrl(req) });
                return res.status(200).json({ result });
            }

            /* ---------------- on sale / off sale ----------------
               There is no capacity to set: a night has the seats in
               seating.js, less accessible seats not released, less blocks. */
            case 'set-performance': {
                if (!isDate(body.performanceDate)) return res.status(400).json({ error: 'performanceDate required' });
                if (body.onSale === undefined) return res.status(400).json({ error: 'Nothing to change' });
                const [row] = await sbUpdate(
                    'performances',
                    `key=eq.${enc(body.performanceDate)}`,
                    { on_sale: Boolean(body.onSale) }
                );
                return res.status(200).json({ performance: row });
            }

            /* ---------------- email ---------------- */
            case 'resend-confirmation': {
                if (!body.bookingRef) return res.status(400).json({ error: 'bookingRef required' });
                const result = await sendConfirmationFor(String(body.bookingRef), {
                    force: true,
                    kind: body.kind === 'seats-updated' ? 'seats-updated' : 'resend',
                    url: siteUrl(req)
                });
                if (result.sent)  return res.status(200).json({ ok: true, provider: result.provider });
                return res.status(200).json({
                    ok: false,
                    reason: result.skipped || result.error || 'could not send'
                });
            }

            /* Why the contact form or a confirmation would not send. Addresses
               are masked and no key is ever returned, but it is behind the
               password anyway. `to` sends a real test email and hands back
               whatever the provider says about it. */
            case 'email-check': {
                const report = {
                    configured: emailConfigured(),
                    providers: configuredProviders(),
                    problem: emailConfigProblem(),
                    from: maskAddress(process.env.EMAIL_FROM),
                    replyTo: maskAddress(process.env.EMAIL_REPLY_TO),
                    bcc: maskAddress(process.env.EMAIL_BCC),
                    enquiriesTo: parseAddressList(ENQUIRIES_TO).map(a => maskAddress(a.email)),
                    accessRequestsTo: accessTeamAddresses().map(maskAddress)
                };

                if (!body.to) return res.status(200).json(report);

                try {
                    const sent = await sendEmail({
                        to: String(body.to),
                        subject: `${SHOW.name} — email test`,
                        text: 'If you are reading this, the site can send email.',
                        html: '<p>If you are reading this, the site can send email.</p>',
                        bcc: false
                    });
                    return res.status(200).json({ ...report, test: { ok: true, provider: sent.provider } });
                } catch (err) {
                    return res.status(200).json({
                        ...report,
                        test: {
                            ok: false,
                            kind: err.kind || 'provider',
                            detail: String(err.message || err).slice(0, 400)
                        }
                    });
                }
            }

            case 'email-log': {
                const filters = ['select=*', 'order=created_at.desc', 'limit=200'];
                if (body.bookingRef) {
                    filters.push(`booking_reference=eq.${enc(body.bookingRef)}`);
                }
                const rows = await sbSelect('email_log?' + filters.join('&'));
                return res.status(200).json({ log: rows });
            }

            case 'run-reconcile': {
                const result = await runReconcile(siteUrl(req));
                return res.status(200).json(result);
            }

            /* ---------------- message wall moderation ---------------- */
            case 'wall-list': {
                const rows = await sbSelect('messages?select=*&order=created_at.desc&limit=500');
                return res.status(200).json({ messages: rows });
            }

            case 'wall-moderate': {
                if (!body.id) return res.status(400).json({ error: 'id required' });
                const patch = {};
                if (body.approved !== undefined) patch.approved = Boolean(body.approved);
                if (body.hidden   !== undefined) patch.hidden   = Boolean(body.hidden);
                const [row] = await sbUpdate('messages', `id=eq.${enc(body.id)}`, patch);
                return res.status(200).json({ message: row });
            }

            /* ---------------- seed performances from the site config -------
               Dates and labels only. Seats come from seating.js. */
            case 'sync-performances': {
                if (!Array.isArray(body.performances) || !body.performances.length) {
                    return res.status(400).json({ error: 'performances array required' });
                }
                const rows = body.performances
                    .filter(p => isDate(p.key))
                    .map(p => ({ key: p.key, label: String(p.label || p.key).slice(0, 120) }));
                const saved = await sbInsert('performances', rows, { upsert: true });
                return res.status(200).json({ performances: saved, seatsPerNight: SEAT_MAP.total });
            }

            default:
                return res.status(400).json({ error: 'Unknown action' });
        }
    } catch (err) {
        console.error('admin error:', err);
        return res.status(500).json({ error: 'Something went wrong', detail: String(err.message || err).slice(0, 300) });
    }
}
