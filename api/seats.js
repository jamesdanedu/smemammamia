// GET /api/seats?date=2027-01-28
//
// Public endpoint: which seats the public cannot have that night, and which
// accessible seats have been put on general sale. Never the names attached
// to them, and never why a seat is unavailable — sold, held and blocked all
// look the same from here.
//
// The plan itself is not sent: the browser has seating.js too, and builds
// the same seats from it.

import { applyCors, supabaseConfigured } from './_supabase.js';
import { loadSeatState, publicView, countNight } from './_seats.js';

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
        const state = await loadSeatState(date);
        const { unavailable, released } = publicView(state);
        const counts = countNight(state);

        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).json({
            date,
            unavailable,
            released,
            remaining: counts.free
        });

    } catch (err) {
        console.error('seats error:', err);
        return res.status(500).json({ error: 'Could not load the seating plan' });
    }
}
