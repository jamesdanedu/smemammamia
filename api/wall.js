// GET  /api/wall            → approved, visible messages
// POST /api/wall  { author, body }  → submit a message (held for approval)

import { applyCors, readBody, sbSelect, sbInsert, supabaseConfigured } from './_supabase.js';

const AUTO_APPROVE = process.env.WALL_AUTO_APPROVE === 'true';

// light-touch filter — the admin page is the real moderation
const BLOCKED = /\b(fuck|shit|bitch|cunt|bastard|wanker|slut|whore|nigg|fag)\b/i;

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'Message wall not configured' });
    }

    /* ---------------- read ---------------- */
    if (req.method === 'GET') {
        try {
            const rows = await sbSelect(
                'messages?select=id,author,body,created_at&approved=is.true&hidden=is.false' +
                '&order=created_at.desc&limit=200'
            );
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ messages: rows });
        } catch (err) {
            console.error('wall read error:', err);
            return res.status(500).json({ error: 'Could not load messages' });
        }
    }

    /* ---------------- write ---------------- */
    if (req.method === 'POST') {
        const { author, body: text } = readBody(req);
        const name = String(author || '').trim().slice(0, 60);
        const message = String(text || '').trim().slice(0, 500);

        if (name.length < 2)    return res.status(400).json({ error: 'Please add your name.' });
        if (message.length < 2) return res.status(400).json({ error: 'Please write a message.' });
        if (BLOCKED.test(name) || BLOCKED.test(message)) {
            return res.status(400).json({ error: 'Please keep it friendly — that message was not posted.' });
        }

        try {
            const [row] = await sbInsert('messages', [{
                author: name,
                body: message,
                approved: AUTO_APPROVE
            }]);
            return res.status(200).json({
                ok: true,
                approved: Boolean(row?.approved),
                message: row?.approved ? row : null
            });
        } catch (err) {
            console.error('wall write error:', err);
            return res.status(500).json({ error: 'Could not post your message' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
