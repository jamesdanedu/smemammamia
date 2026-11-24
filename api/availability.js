// GET /api/availability
// Public endpoint. Returns only aggregate numbers — never customer data.
//
// GET /prices.js (rewritten here with ?format=js, see vercel.json) returns the
// ticket prices set in Vercel as a tiny script every page loads before
// config.js, so the prices a page shows are the prices the server charges.
//
// What is on sale comes from the seat plan, not a typed capacity: every
// seat in seating.js, less the accessible seats not released, less any
// blocked in admin.

import { applyCors, sbSelect, supabaseConfigured } from './_supabase.js';
import { countAllNights } from './_seats.js';
import { TICKET_PRICE, STUDENT_PRICE, CHILD_PRICE, CHILD_AGE } from './_show.js';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.query?.format === 'js') {
        const prices = { standard: TICKET_PRICE, student: STUDENT_PRICE, child: CHILD_PRICE, childAge: CHILD_AGE };
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        // A minute at the edge: a price change shows within a minute of the redeploy.
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
        return res.status(200).send(`window.SITE_PRICES = ${JSON.stringify(prices)};\n`);
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Database not configured' });
    }

    try {
        const perfs = await sbSelect('performances?select=key,label,on_sale&order=key.asc');
        const counts = await countAllNights(perfs.map(p => p.key));

        const out = {};
        for (const p of perfs) {
            const c = counts[p.key];
            out[p.key] = {
                label: p.label,
                capacity: c.sellable,
                sold: c.sellable - c.free,
                remaining: c.free,
                onSale: p.on_sale,
                soldOut: c.free <= 0 || !p.on_sale
            };
        }

        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).json(out);

    } catch (err) {
        console.error('availability error:', err);
        return res.status(500).json({ error: 'Could not load availability' });
    }
}
