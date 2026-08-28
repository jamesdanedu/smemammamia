// GET /api/availability
// Public endpoint. Returns only aggregate numbers — never customer data.

import { applyCors, sbSelect, supabaseConfigured } from './_supabase.js';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Database not configured' });
    }

    try {
        const rows = await sbSelect(
            'performance_availability?select=key,label,capacity,on_sale,sold,remaining&order=key.asc'
        );

        const out = {};
        for (const r of rows) {
            out[r.key] = {
                label: r.label,
                capacity: r.capacity,
                sold: r.sold,
                remaining: r.remaining,
                onSale: r.on_sale,
                soldOut: r.remaining <= 0 || !r.on_sale
            };
        }

        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).json(out);

    } catch (err) {
        console.error('availability error:', err);
        return res.status(500).json({ error: 'Could not load availability' });
    }
}
