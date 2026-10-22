// Seats, from the server's side.
//
// The plan itself comes from seating.js; the database only knows which seats
// are taken, blocked or released. This is where the two are put together —
// for the public map, the availability counts and the admin Overview — so
// every page counts a night the same way.

import { sbSelect } from './_supabase.js';
import { SEAT_MAP, ACCESSIBLE_IDS, cleanSeats, restrictedSeats } from '../seating.js';

const enc = encodeURIComponent;

/**
 * Everything the database knows about one night's seats. Rows, not counts —
 * the counting is done here.
 */
export async function loadSeatState(date) {
    const where = `&performance_date=eq.${enc(date)}`;
    const [taken, blocks, releases] = await Promise.all([
        sbSelect('taken_seats?select=performance_date,seat_id,status,booking_reference,customer_name,payment_status' + where),
        sbSelect('seat_blocks?select=performance_date,seat_id,note' + where),
        sbSelect('accessible_releases?select=performance_date,seat_id' + where)
    ]);
    return { taken, blocks, releases };
}

/**
 * What the public sees for one night: seats they cannot have, and the
 * accessible seats that have been put on general sale. Blocked seats are
 * folded into `unavailable` — nobody needs to know why a seat is not for sale.
 */
export function publicView({ taken, blocks, releases }) {
    const unavailable = cleanSeats([...taken.map(r => r.seat_id), ...blocks.map(r => r.seat_id)]);
    const released = cleanSeats(releases.map(r => r.seat_id));
    return { unavailable, released };
}

/**
 * The figures for one night.
 *
 *   sellable  = every seat − accessible not released − blocked
 *   sold      seats on confirmed bookings (staff bookings on accessible or
 *             blocked seats included — they are people in seats)
 *   held      seats on holds that are still running
 *   free      sellable seats nobody has, i.e. what the public can still buy
 */
export function countNight({ taken = [], blocks = [], releases = [] } = {}) {
    const released   = new Set(releases.map(r => r.seat_id));
    const blocked    = new Set(blocks.map(r => r.seat_id));
    const restricted = new Set(restrictedSeats([...released]));
    const takenSet   = new Set(taken.map(r => r.seat_id));

    const offSale = new Set([...restricted, ...blocked]);
    const sellable = SEAT_MAP.total - offSale.size;

    let free = 0;
    for (const id of SEAT_MAP.seats.map(s => s.id)) {
        if (!offSale.has(id) && !takenSet.has(id)) free++;
    }

    const accessibleTaken = ACCESSIBLE_IDS.filter(id => takenSet.has(id)).length;
    const accessibleReleased = ACCESSIBLE_IDS.filter(id => released.has(id)).length;

    return {
        total: SEAT_MAP.total,
        sellable,
        sold: taken.filter(r => r.status === 'confirmed').length,
        held: taken.filter(r => r.status === 'held').length,
        free,
        blocked: blocked.size,
        accessible: {
            total: ACCESSIBLE_IDS.length,
            assigned: accessibleTaken,
            released: accessibleReleased,
            // neither assigned nor released: still kept for access requests
            free: ACCESSIBLE_IDS.filter(id => !takenSet.has(id) && !released.has(id)).length
        }
    };
}

/**
 * countNight for every night: { '2027-01-28': {...}, ... }
 *
 * One request per night rather than one for the lot: Supabase hands back at
 * most 1,000 rows a request, and two full nights is 1,008 seats.
 */
export async function countAllNights(dates) {
    const states = await Promise.all(dates.map(d => loadSeatState(d)));
    const out = {};
    dates.forEach((d, i) => { out[d] = countNight(states[i]); });
    return out;
}

/**
 * Turn a database refusal into the seats it names.
 *   'SEAT_TAKEN:A1,A2'      -> { kind: 'taken', seats: ['A1','A2'] }
 *   'SEAT_RESTRICTED:J1'    -> { kind: 'restricted', seats: ['J1'] }
 */
export function seatRefusal(message) {
    const m = /(SEAT_TAKEN|SEAT_RESTRICTED):([A-Z0-9,]+)/.exec(String(message || ''));
    if (!m) return null;
    return { kind: m[1] === 'SEAT_TAKEN' ? 'taken' : 'restricted', seats: cleanSeats(m[2]) };
}
