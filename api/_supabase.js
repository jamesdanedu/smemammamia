// Thin PostgREST client — no npm dependencies.
// Uses the service_role key, so it must only ever run server side.

const BASE = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function supabaseConfigured() {
    return Boolean(BASE && KEY);
}

function headers(extra = {}) {
    return {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

/** GET /rest/v1/<path> — e.g. sbSelect("bookings?select=*&status=eq.confirmed") */
export async function sbSelect(path) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase select failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : [];
}

/** POST /rest/v1/<table> */
export async function sbInsert(table, rows, { upsert = false } = {}) {
    const res = await fetch(`${BASE}/rest/v1/${table}`, {
        method: 'POST',
        headers: headers({
            Prefer: `return=representation${upsert ? ',resolution=merge-duplicates' : ''}`
        }),
        body: JSON.stringify(rows)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase insert failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : [];
}

/** PATCH /rest/v1/<table>?<filter> */
export async function sbUpdate(table, filter, patch) {
    const res = await fetch(`${BASE}/rest/v1/${table}?${filter}`, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify(patch)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase update failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : [];
}

/** POST /rest/v1/rpc/<fn> */
export async function sbRpc(fn, args) {
    const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(args)
    });
    const text = await res.text();
    if (!res.ok) {
        let message = text;
        try { message = JSON.parse(text).message || text; } catch { /* keep raw */ }
        const err = new Error(message);
        err.pgMessage = message;
        err.status = res.status;
        throw err;
    }
    return text ? JSON.parse(text) : null;
}

/* ---------- shared request helpers ---------- */

export function applyCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true;
    }
    return false;
}

export function requireMethod(req, res, method) {
    if (req.method !== method) {
        res.status(405).json({ error: 'Method not allowed' });
        return false;
    }
    return true;
}

export function readBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch { return {}; }
    }
    return req.body;
}

/** Booking reference, e.g. MM-4F2K9A */
export function newBookingRef() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return 'MM-' + out;
}
