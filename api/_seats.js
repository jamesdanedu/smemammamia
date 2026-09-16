// Making sure a confirmed booking has seats.
//
// Normally create_hold takes the tickets and the seats together and there is
// nothing to do here. The exception is a payment that arrives after its hold
// ran out: the customer paid, the hold expired, release_stale_seats handed
// the seats back, and somebody else may have bought them. The money is real,
// so the booking stands — it just needs seats again.

import { sbSelect, sbRpc } from './_supabase.js';
import { allocateSeats, cleanSeats, describeSeats } from '../seating.js';

/**
 * Give `reference` seats if it has none. Safe to call on a booking that is
 * already seated: assign_seats returns what it has rather than moving anybody.
 *
 * Retries on a clash because the seats it picked can be sold between reading
 * the map and taking the lock — rare, and a second look is all it takes.
 */
export async function ensureSeats(reference, performanceDate, quantity, { tries = 3 } = {}) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        let wanted;
        try {
            const taken = await sbSelect(
                `taken_seats?select=seat_id&performance_date=eq.${encodeURIComponent(performanceDate)}`
            );
            wanted = allocateSeats(quantity, taken.map(r => r.seat_id));
        } catch (err) {
            return { seats: [], error: 'could not read the seat map: ' + err.message };
        }

        if (wanted.length !== quantity) {
            return { seats: [], error: 'the night is too full to seat this booking' };
        }

        try {
            const got = cleanSeats(await sbRpc('assign_seats', {
                p_reference: reference,
                p_seats: wanted
            }));
            return { seats: got, label: describeSeats(got) };
        } catch (err) {
            const msg = err.pgMessage || err.message || '';
            // Somebody took one while we were deciding. Look again.
            if (msg.includes('SEAT_TAKEN') && attempt < tries) continue;
            return { seats: [], error: msg || 'could not assign seats' };
        }
    }

    return { seats: [], error: 'could not hold seats after ' + tries + ' tries' };
}
