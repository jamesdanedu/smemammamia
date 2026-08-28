// POST /api/admin  { password, action, ... }
//
// Every admin read and write happens here, behind ADMIN_PASSWORD.
// Customer details never leave this function without the password.

import crypto from 'node:crypto';
import {
    applyCors, requireMethod, readBody,
    sbSelect, sbUpdate, sbRpc, sbInsert, newBookingRef, supabaseConfigured
} from './_supabase.js';
import { sendConfirmationFor } from './_confirmations.js';
import { emailConfigured, configuredProviders } from './_email.js';
import { runReconcile } from './reconcile.js';
import { siteUrl } from './_show.js';

const TICKET_PRICE = Number(process.env.TICKET_PRICE || 15);

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
                const [availability, bookings] = await Promise.all([
                    sbSelect('performance_availability?select=*&order=key.asc'),
                    sbSelect('bookings?select=performance_date,quantity,amount,status,payment_status,' +
                             'booked_by,confirmation_sent_at,last_email_error,over_capacity')
                ]);

                const confirmed = bookings.filter(b => b.status === 'confirmed');
                const revenue = confirmed
                    .filter(b => ['paid', 'cash'].includes(b.payment_status))
                    .reduce((t, b) => t + Number(b.amount), 0);

                const bySeller = {};
                for (const b of confirmed) {
                    const who = b.booked_by || 'WEB';
                    bySeller[who] = (bySeller[who] || 0) + b.quantity;
                }

                return res.status(200).json({
                    performances: availability,
                    totals: {
                        bookings: confirmed.length,
                        tickets: confirmed.reduce((t, b) => t + b.quantity, 0),
                        revenue: Number(revenue.toFixed(2)),
                        onlineTickets: confirmed.filter(b => b.payment_status === 'paid').reduce((t, b) => t + b.quantity, 0),
                        cashTickets:   confirmed.filter(b => b.payment_status === 'cash').reduce((t, b) => t + b.quantity, 0)
                    },
                    bySeller,
                    email: {
                        configured: emailConfigured(),
                        providers: configuredProviders(),
                        pending: bookings.filter(b => b.status === 'confirmed' && !b.confirmation_sent_at).length,
                        failing: bookings.filter(b => b.status === 'confirmed' && !b.confirmation_sent_at && b.last_email_error).length
                    },
                    overCapacity: bookings.filter(b => b.over_capacity).length
                });
            }

            /* ---------------- booking list ---------------- */
            case 'list': {
                const filters = ['select=*', 'order=created_at.desc', 'limit=1000'];
                if (body.performanceDate) filters.push(`performance_date=eq.${encodeURIComponent(body.performanceDate)}`);
                if (body.status)          filters.push(`status=eq.${encodeURIComponent(body.status)}`);
                const rows = await sbSelect('bookings?' + filters.join('&'));
                return res.status(200).json({ bookings: rows });
            }

            /* ---------------- door list ---------------- */
            case 'door-list': {
                if (!body.performanceDate) return res.status(400).json({ error: 'performanceDate required' });
                const rows = await sbSelect(
                    'bookings?select=booking_reference,customer_name,quantity,booked_by,payment_status' +
                    `&performance_date=eq.${encodeURIComponent(body.performanceDate)}` +
                    '&status=eq.confirmed&order=customer_name.asc'
                );
                return res.status(200).json({ bookings: rows });
            }

            /* ---------------- cash / door booking ---------------- */
            case 'cash-booking': {
                const quantity = parseInt(body.quantity, 10);
                if (!body.performanceDate || !Number.isInteger(quantity) || quantity < 1) {
                    return res.status(400).json({ error: 'Performance and quantity are required' });
                }
                const name = String(body.customerName || '').trim();
                if (name.length < 2) return res.status(400).json({ error: 'Customer name is required' });

                const reference = newBookingRef();
                const amount = Number((quantity * TICKET_PRICE).toFixed(2));

                try {
                    await sbRpc('create_hold', {
                        p_reference:    reference,
                        p_date:         body.performanceDate,
                        p_quantity:     quantity,
                        p_amount:       amount,
                        p_name:         name,
                        p_email:        String(body.customerEmail || '').trim().toLowerCase() || 'door@stmarys.local',
                        p_phone:        String(body.customerPhone || '').trim(),
                        p_booked_by:    String(body.bookedBy || 'DOOR').trim(),
                        p_hold_minutes: 5
                    });
                } catch (err) {
                    const msg = err.pgMessage || err.message || '';
                    if (msg.includes('SOLD_OUT')) {
                        const left = parseInt(msg.split('SOLD_OUT:')[1], 10);
                        return res.status(409).json({ error: `Not enough tickets left (${left || 0} remaining).` });
                    }
                    throw err;
                }

                const [row] = await sbUpdate('bookings', `booking_reference=eq.${reference}`, {
                    status: 'confirmed',
                    payment_status: body.free ? 'refunded' : 'cash',
                    payment_method: body.free ? 'comp' : 'cash',
                    held_until: null,
                    notes: String(body.notes || '').trim() || null
                });

                // Door sales get a confirmation too, when an address was given.
                let emailResult = { sent: false, skipped: 'no email address' };
                try {
                    emailResult = await sendConfirmationFor(reference, { url: siteUrl(req) });
                } catch (err) {
                    console.error('door-sale confirmation failed', err.message);
                }

                return res.status(200).json({ booking: row, email: emailResult });
            }

            /* ---------------- cancel ---------------- */
            case 'cancel': {
                if (!body.bookingRef) return res.status(400).json({ error: 'bookingRef required' });
                const [row] = await sbUpdate(
                    'bookings',
                    `booking_reference=eq.${encodeURIComponent(body.bookingRef)}`,
                    { status: 'cancelled', held_until: null, notes: String(body.reason || 'Cancelled by admin').slice(0, 300) }
                );
                return res.status(200).json({ booking: row });
            }

            /* ---------------- capacity / on sale ---------------- */
            case 'set-performance': {
                if (!body.performanceDate) return res.status(400).json({ error: 'performanceDate required' });
                const patch = {};
                if (body.capacity !== undefined) patch.capacity = parseInt(body.capacity, 10);
                if (body.onSale !== undefined)   patch.on_sale = Boolean(body.onSale);
                if (!Object.keys(patch).length)  return res.status(400).json({ error: 'Nothing to change' });

                const [row] = await sbUpdate(
                    'performances',
                    `key=eq.${encodeURIComponent(body.performanceDate)}`,
                    patch
                );
                return res.status(200).json({ performance: row });
            }

            /* ---------------- email ---------------- */
            case 'resend-confirmation': {
                if (!body.bookingRef) return res.status(400).json({ error: 'bookingRef required' });
                const result = await sendConfirmationFor(String(body.bookingRef), {
                    force: true,
                    kind: 'resend',
                    url: siteUrl(req)
                });
                if (result.sent)  return res.status(200).json({ ok: true, provider: result.provider });
                return res.status(200).json({
                    ok: false,
                    reason: result.skipped || result.error || 'could not send'
                });
            }

            case 'email-log': {
                const filters = ['select=*', 'order=created_at.desc', 'limit=200'];
                if (body.bookingRef) {
                    filters.push(`booking_reference=eq.${encodeURIComponent(body.bookingRef)}`);
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
                const [row] = await sbUpdate('messages', `id=eq.${encodeURIComponent(body.id)}`, patch);
                return res.status(200).json({ message: row });
            }

            /* ---------------- seed performances from the site config ------- */
            case 'sync-performances': {
                if (!Array.isArray(body.performances) || !body.performances.length) {
                    return res.status(400).json({ error: 'performances array required' });
                }
                const rows = body.performances.map(p => ({
                    key: p.key,
                    label: p.label,
                    capacity: parseInt(p.capacity, 10) || 0
                }));
                const saved = await sbInsert('performances', rows, { upsert: true });
                return res.status(200).json({ performances: saved });
            }

            default:
                return res.status(400).json({ error: 'Unknown action' });
        }
    } catch (err) {
        console.error('admin error:', err);
        return res.status(500).json({ error: 'Something went wrong', detail: String(err.message || err).slice(0, 300) });
    }
}
