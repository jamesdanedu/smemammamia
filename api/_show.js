// Show details the email templates need.
//
// ⚠️  KEEP IN SYNC WITH config.js — the browser reads config.js, the server
//     reads this. Only these five values are duplicated. If you change the
//     venue or times, change them in both places. The accessibility options
//     below are duplicated the same way.
//
// Anything set as a Vercel environment variable wins, so you can correct a
// time without a redeploy.

export const SHOW = {
    name:      process.env.SHOW_NAME     || 'Mamma Mia!',
    school:    process.env.SHOW_SCHOOL   || "St Mary's Secondary School, Edenderry",
    venue:     process.env.SHOW_VENUE    || "St Mary's Secondary School, Edenderry, Co. Offaly",
    doors:     process.env.SHOW_DOORS    || '7:00 PM',
    curtain:   process.env.SHOW_CURTAIN  || '7:30 PM'
};

/**
 * The accessibility question asked at booking. Only these codes are ever
 * stored on a booking; anything else the browser sends is dropped.
 *
 * ⚠️  KEEP IN SYNC WITH config.js — the browser renders that list, the
 *     server validates against this one.
 */
export const ACCESS_OPTIONS = [
    { code: 'wheelchair', label: 'Wheelchair space' },
    { code: 'aisle',      label: 'Aisle seat or extra legroom' },
    { code: 'hearing',    label: 'Hearing support' },
    { code: 'other',      label: 'Something else' }
];

/** ['wheelchair','aisle'] or 'wheelchair,aisle' -> ['Wheelchair space', ...] */
export function accessLabels(codes) {
    const list = Array.isArray(codes) ? codes : String(codes || '').split(',');
    return list
        .map(c => String(c).trim())
        .filter(Boolean)
        .map(c => ACCESS_OPTIONS.find(o => o.code === c)?.label || c);
}

/**
 * Keep only codes we know about, in the order they are offered, with no
 * duplicates. Returns a comma-separated string ready for the database.
 */
export function cleanAccessNeeds(codes) {
    const list = Array.isArray(codes) ? codes : String(codes || '').split(',');
    const wanted = new Set(list.map(c => String(c).trim()));
    return ACCESS_OPTIONS.filter(o => wanted.has(o.code)).map(o => o.code).join(',');
}

/**
 * Where questions from the contact form land, and the address to give somebody
 * when the form itself cannot send. ENQUIRIES_TO in Vercel wins over the
 * default, so moving the inbox needs no redeploy — but the default is what the
 * site falls back on, so keep it pointing somewhere that is actually read.
 */
export const DEFAULT_ENQUIRIES_TO = 'smemammamia@proton.me';
export const ENQUIRIES_TO = process.env.ENQUIRIES_TO || DEFAULT_ENQUIRIES_TO;

/** Public site URL, e.g. https://mammamiathemusical.ie — used for links in emails. */
export function siteUrl(req) {
    if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
    if (!host) return '';
    return (String(host).includes('localhost') ? 'http://' : 'https://') + host;
}

/** '2027-01-27' -> 'Wednesday 27th January 2027' */
export function formatPerformanceDate(iso, fallbackLabel) {
    if (fallbackLabel) return fallbackLabel;
    const d = new Date(iso + 'T12:00:00Z');
    if (isNaN(d)) return iso;

    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const n = d.getUTCDate();
    const suffix = (n % 10 === 1 && n !== 11) ? 'st'
                 : (n % 10 === 2 && n !== 12) ? 'nd'
                 : (n % 10 === 3 && n !== 13) ? 'rd' : 'th';

    return `${days[d.getUTCDay()]} ${n}${suffix} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** 24-hour time from '7:30 PM', for the calendar attachment. */
export function to24(t) {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t).trim());
    if (!m) return '19:30';
    let h = parseInt(m[1], 10);
    if (/pm/i.test(m[3]) && h !== 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + m[2];
}
