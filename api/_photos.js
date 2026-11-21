// Supabase Storage helpers for the photo gallery. Server side only.
//
// Files go in the public "photos" bucket (created by schema-photos.sql).
// The browser never sees the service key: /api/admin asks Storage for a
// one-time signed upload URL and the admin page PUTs the file to that.

const BASE   = process.env.SUPABASE_URL;
const KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const BUCKET = 'photos';

export const PHOTO_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

// Every path this site writes looks like 20261121-164512-k3j9x2.webp
export const PATH_RE = /^\d{8}-\d{6}-[a-z0-9]{6}\.(webp|jpg|png)$/;

const auth = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}` });

export function publicUrl(path) {
    return `${BASE}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(path)}`;
}

export function newPhotoPath(type) {
    const ext = PHOTO_TYPES[type];
    if (!ext) return null;
    const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);   // YYYYMMDDHHMMSS
    const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    return `${d.slice(0, 8)}-${d.slice(8)}-${rand}.${ext}`;
}

/** A one-time URL the browser can PUT one file to. Valid for 2 hours. */
export async function signedUploadUrl(path) {
    const res = await fetch(`${BASE}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: '{}'
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Storage sign failed (${res.status}): ${text.slice(0, 200)}`);
    const { url } = JSON.parse(text);            // "/object/upload/sign/photos/<path>?token=…"
    return `${BASE}/storage/v1${url}`;
}

/** Remove files from the bucket. Missing files are not an error. */
export async function removeObjects(paths) {
    if (!paths.length) return;
    const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths })
    });
    if (!res.ok) throw new Error(`Storage delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
