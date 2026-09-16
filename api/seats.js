// GET /api/seats?date=2027-01-28
//
// Public endpoint: which seats are gone for that night, and nothing else.
// Never the names attached to them — the booking page only needs to know
// what it cannot offer.
//
// The plan itself is not sent: the browser has seating.js too, and builds
// the same 500 ids from the same measurements.

import { applyCors, sbSelect, supabaseConfigured } from './_supabase.js';
import { SEAT_MAP } from '../seating.js';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const date = String(req.query?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'A performance date is required.' });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Booking system not configured' });
    }

    try {
        const rows = await sbSelect(
            `taken_seats?select=seat_id&performance_date=eq.${encodeURIComponent(date)}`
        );

        const taken = rows.map(r => r.seat_id);

        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).json({
            date,
            taken,
            total: SEAT_MAP.total,
            remaining: Math.max(SEAT_MAP.total - taken.length, 0)
        });

    } catch (err) {
        console.error('seats error:', err);
        return res.status(500).json({ error: 'Could not load the seating map' });
    }
}
