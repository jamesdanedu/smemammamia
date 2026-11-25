// GET /api/photos          → the visible photos, in order, for the Photos page.
// GET /api/photos?set=cast → { photos: { "<lower-case name>": url } } for the
//                            Cast page: the portraits chosen in admin.
//
// Returns an empty list (not an error) when Supabase isn't set up, so the page
// just falls back to whatever is listed in photos.js.

import { applyCors, requireMethod, sbSelect, supabaseConfigured } from './_supabase.js';
import { publicUrl } from './_photos.js';

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (!requireMethod(req, res, 'GET')) return;

    if (!supabaseConfigured()) return res.status(200).json({ photos: [] });

    if (req.query?.set === 'cast') {
        try {
            const rows = await sbSelect('cast_photos?select=name,path&limit=500');
            return res.status(200).json({ photos: Object.fromEntries(rows.map(r => [r.name, publicUrl(r.path)])) });
        } catch (err) {
            console.error('cast photos read error:', err);
            return res.status(200).json({ photos: {}, error: 'Could not load cast photos' });
        }
    }

    try {
        const rows = await sbSelect(
            'photos?select=path,caption,width,height&visible=is.true&order=sort_order.asc,id.asc&limit=500'
        );
        res.setHeader('Cache-Control', 'no-store');   // vercel.json sets this for /api anyway
        return res.status(200).json({
            photos: rows.map(r => ({ url: publicUrl(r.path), caption: r.caption, width: r.width, height: r.height }))
        });
    } catch (err) {
        console.error('photos read error:', err);
        return res.status(200).json({ photos: [], error: 'Could not load photos' });
    }
}
