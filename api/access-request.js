// POST /api/access-request
//   { performanceDate, name, email, phone, wheelchairSpaces, companionSeats, notes, website, elapsed }
//
// "Need accessible seating?" on the booking page. Accessible seats are not
// sold online: the request is stored, the production team is emailed, and the
// person gets an acknowledgement saying the team will be in touch. The team
// then books the seats from the admin Access requests tab.
//
// The request is stored before anything is emailed, so a provider outage
// never loses it — it shows on the admin Overview either way, and the
// reconciler retries any email that did not go.

import { applyCors, readBody, sbSelect, sbInsert, supabaseConfigured } from './_supabase.js';
import { sendAccessEmails } from './_access.js';
import { siteUrl } from './_show.js';

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const oneLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const count = (v, max) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

/* Best-effort flood guard, per warm instance — as on the contact form. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map();

function tooMany(ip) {
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter(t => now - t < WINDOW_MS);
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 2000) recent.clear();
    return hits.length > MAX_PER_WINDOW;
}

function newRef() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return 'AR-' + out;
}

export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const b = readBody(req);
    const r = {
        performance_date:  oneLine(b.performanceDate, 10),
        name:              oneLine(b.name, 80),
        email:             oneLine(b.email, 160).toLowerCase(),
        phone:             oneLine(b.phone, 40),
        wheelchair_spaces: count(b.wheelchairSpaces, 10),
        companion_seats:   count(b.companionSeats, 20),
        notes:             String(b.notes ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000)
    };

    // Bots: filled the hidden field, or faster than a person can type.
    if (String(b.website || '').trim() || (Number(b.elapsed) > 0 && Number(b.elapsed) < 2500)) {
        return res.status(200).json({ ok: true, reference: newRef() });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.performance_date)) return res.status(400).json({ error: 'Please choose a night.' });
    if (r.name.length < 2)   return res.status(400).json({ error: 'Please enter your name.' });
    if (!isEmail(r.email))   return res.status(400).json({ error: 'Please enter an email we can reply to.' });
    if (r.phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Please enter a phone number, so the team can call you.' });
    if (r.wheelchair_spaces === null) return res.status(400).json({ error: 'Please say how many wheelchair spaces (0 to 10).' });
    if (r.companion_seats === null)   return res.status(400).json({ error: 'Please say how many companion seats (0 to 20).' });
    if (r.wheelchair_spaces + r.companion_seats < 1) {
        return res.status(400).json({ error: 'Please ask for at least one wheelchair space or seat.' });
    }

    const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    if (tooMany(ip)) {
        return res.status(429).json({ error: 'That is a lot of requests in a short time — please try again in a few minutes.' });
    }

    if (!supabaseConfigured()) {
        return res.status(503).json({ error: 'The request form is not available just now. Please use the contact page.' });
    }

    try {
        const [perf] = await sbSelect(
            `performances?select=key,on_sale&key=eq.${encodeURIComponent(r.performance_date)}&limit=1`
        );
        if (!perf || !perf.on_sale) return res.status(400).json({ error: 'Please choose one of the nights on sale.' });

        const [saved] = await sbInsert('access_requests', [{ ...r, phone: r.phone || null, notes: r.notes || null, reference: newRef() }]);

        // Stored. The emails are a courtesy on top: if they fail the request
        // is still on the admin page, and the reconciler tries again.
        let emails = null;
        try {
            emails = await sendAccessEmails(saved, { url: siteUrl(req) });
        } catch (err) {
            console.error('access request emails threw', err.message);
        }

        return res.status(200).json({
            ok: true,
            reference: saved.reference,
            acknowledged: Boolean(emails?.ack?.sent)
        });

    } catch (err) {
        console.error('access request failed:', err);
        return res.status(500).json({ error: 'Sorry — your request could not be saved just now. Please try again, or use the contact page.' });
    }
}
