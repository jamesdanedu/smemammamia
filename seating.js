/* ==========================================================================
   MAMMA MIA! — St Mary's Edenderry
   The seating plan: one description of the gym floor, used everywhere.
   ==========================================================================

   The show is in the school gym, on the basketball court, with the stage
   built across one end. Everything below is measured in metres so the plan
   the caretaker sets the chairs out from and the map the audience clicks on
   are the same plan — change a number here and both follow.

   >>> THE NUMBERS TO EDIT ARE ALL IN `LAYOUT`, DIRECTLY BELOW. <<<

   Loaded two ways, from this one file:
       browser   <script type="module"> import { SEAT_MAP } from './seating.js'
       server    import { SEAT_MAP } from '../seating.js'
   It also sets window.SEATING in a browser, for the console.

   HOW THE 432 SEATS FIT
   ---------------------
   The hall measures 62 ft x 101 ft (18.90 m x 30.78 m), and the stage
   takes about 35 ft (10.67 m) of the long side.

   Across (18.90 m of hall):   7 + 13 + 7 seats at 0.50 m  = 13.50 m
                               2 aisles at 1.20 m          =  2.40 m
                               side gangways, 1.50 m each  =  3.00 m
   Down   (30.78 m of hall):   stage 10.67 m, then 2.00 m to row A,
                               16 rows at 0.85 m           = 13.60 m
                               cross gangway after row H   =  1.20 m
                               exit gangway behind row R    =  3.00 m
                                                             (0.32 m spare)
   16 rows x 27 seats = 432 seats a night.

   The block sizes are deliberate: no more than 7 seats between a seated
   person and an aisle where there is only one aisle to reach (the side
   blocks), no more than 14 where there are aisles at both ends (the centre
   block), and every gangway at least 1.05 m wide.
   ========================================================================== */

export const LAYOUT = {

    /* --- The room ------------------------------------------------------
       Measure the clear floor, not the court markings — the chairs can
       stand on the run-off either side of the lines.
       ------------------------------------------------------------------ */
    hall: {
        lengthM: 30.785,      // 101 ft — stage end to back wall
        widthM:  18.898       // 62 ft — side wall to side wall
    },

    /* --- The stage ------------------------------------------------------ */
    stage: {
        depthM:     10.668,   // 35 ft — how far the staging comes out from the end wall
        heightM:     1.1,     // deck height above the floor; see sightlines() below
        clearanceM:  2.0      // floor kept clear between the stage and row A
    },

    /* --- The chairs ----------------------------------------------------- */
    seat: {
        widthM: 0.50,         // a stacking chair, seat to seat
        pitchM: 0.85          // front of one row to front of the next
                              // (0.45 m chair + 0.40 m to get past — keep >= 0.75)
    },

    /* --- Rows and blocks ------------------------------------------------
       Change the block sizes and the row count and everything else — the
       map, the plan, the seat numbers — follows. Keep an eye on the
       warnings from checkFit() if you do.
       ------------------------------------------------------------------- */
    rows: 16,
    blocks: [
        { id: 'L', name: 'Left',   seats: 7  },
        { id: 'C', name: 'Centre', seats: 13 },
        { id: 'R', name: 'Right',  seats: 7  }
    ],

    /* --- Gangways ------------------------------------------------------- */
    aisleM:        1.20,      // between blocks
    crossAisle:    { afterRow: 8, widthM: 1.20 },  // 0 = none
    rearGangwayM:  3.00,      // behind the last row, to the exits

    /* --- Seats kept for people who need them ----------------------------
       Nothing is removed from the 432: a wheelchair bay is a chair that
       gets taken away on the night, which is why the seat still has a
       number and can still be booked by anyone if nobody needs it.

       Both lists are seat ids. The defaults sit on a gangway: row A is off
       the front clearance, row J is off the cross gangway, so neither
       needs a squeeze past anybody else's knees.
       ------------------------------------------------------------------- */
    wheelchairSeats: ['J1', 'J2', 'J26', 'J27'],
    stepFreeSeats:   ['A1', 'A2', 'A26', 'A27', 'J7', 'J8', 'J20', 'J21'],

    /* --- Row letters ----------------------------------------------------
       I and O are skipped: too easily read as 1 and 0 on a printed list.
       ------------------------------------------------------------------- */
    rowLetters: null          // null = work them out (A, B, ... skipping I and O)
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I, no O

/* ---------------------------------------------------------------- build -- */

/** Row letters for `n` rows: A, B, … skipping I and O, then AA, AB, … */
export function rowLetters(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(i < ALPHABET.length
            ? ALPHABET[i]
            : ALPHABET[Math.floor(i / ALPHABET.length) - 1] + ALPHABET[i % ALPHABET.length]);
    }
    return out;
}

/**
 * Turn the measurements above into every seat, with where it stands on the
 * floor in metres. x runs left to right as the audience faces the stage,
 * y runs back from the end wall the stage is built against.
 */
export function buildSeatMap(layout = LAYOUT) {
    const { hall, stage, seat, blocks, aisleM, crossAisle, rearGangwayM } = layout;

    const letters      = layout.rowLetters || rowLetters(layout.rows);
    const seatsPerRow  = blocks.reduce((t, b) => t + b.seats, 0);
    const rowWidthM    = seatsPerRow * seat.widthM + (blocks.length - 1) * aisleM;
    const sideGangwayM = (hall.widthM - rowWidthM) / 2;

    const crossAfter   = crossAisle && crossAisle.afterRow > 0 ? crossAisle.afterRow : 0;
    const crossWidthM  = crossAfter ? crossAisle.widthM : 0;
    const firstRowY    = stage.depthM + stage.clearanceM;

    const wheelchair = new Set(layout.wheelchairSeats || []);
    const stepFree   = new Set(layout.stepFreeSeats   || []);

    const rows = [];
    const seats = [];
    const byId = new Map();

    for (let r = 0; r < layout.rows; r++) {
        const letter = letters[r];
        const y = firstRowY + r * seat.pitchM + (r >= crossAfter && crossAfter ? crossWidthM : 0);

        const rowSeats = [];
        let number = 0;
        let x = sideGangwayM;

        for (const block of blocks) {
            for (let i = 0; i < block.seats; i++) {
                number += 1;
                const id = letter + number;
                const s = {
                    id,
                    row: letter,
                    rowIndex: r,
                    number,
                    blockId: block.id,
                    blockName: block.name,
                    seatInBlock: i + 1,
                    // centre of the chair, in metres from the left wall / end wall
                    x: Number((x + seat.widthM / 2).toFixed(3)),
                    y: Number((y + seat.pitchM / 2).toFixed(3)),
                    wheelchair: wheelchair.has(id),
                    stepFree: wheelchair.has(id) || stepFree.has(id),
                    // which side of the cross gangway you walk in from
                    half: crossAfter && r >= crossAfter ? 'rear' : 'front'
                };
                seats.push(s);
                rowSeats.push(s);
                byId.set(id, s);
                x += seat.widthM;
            }
            x += aisleM;   // trailing aisle on the last block is never drawn
        }

        rows.push({
            letter,
            index: r,
            y: Number(y.toFixed(3)),
            seats: rowSeats,
            half: crossAfter && r >= crossAfter ? 'rear' : 'front',
            // true for the row you reach straight off a gangway
            offGangway: r === 0 || (crossAfter ? r === crossAfter : false)
        });
    }

    const depthUsedM = firstRowY + layout.rows * seat.pitchM + crossWidthM + rearGangwayM;

    return {
        layout,
        rows,
        seats,
        byId,
        blocks: blocks.map(b => ({ ...b })),
        letters,
        seatsPerRow,
        total: seats.length,
        geometry: {
            rowWidthM:    Number(rowWidthM.toFixed(3)),
            sideGangwayM: Number(sideGangwayM.toFixed(3)),
            firstRowY:    Number(firstRowY.toFixed(3)),
            crossAfter,
            crossWidthM,
            depthUsedM:   Number(depthUsedM.toFixed(3)),
            spareDepthM:  Number((hall.lengthM - depthUsedM).toFixed(3))
        }
    };
}

/**
 * Does the plan actually fit, and is it safe to walk out of?
 * Returns the numbers plus anything that wants looking at, so a change to
 * LAYOUT tells you what it broke instead of quietly drawing nonsense.
 *
 * The thresholds are the ordinary ones for a temporary public seating
 * layout (1.05 m gangways; 7 seats to a single aisle, 14 between two).
 * They are a sanity check, not a substitute for the fire officer.
 */
export function checkFit(map = SEAT_MAP) {
    const { layout, geometry, blocks } = map;
    const problems = [];
    const MIN_GANGWAY = 1.05;

    if (geometry.sideGangwayM < MIN_GANGWAY) {
        problems.push(`Side gangways are ${geometry.sideGangwayM.toFixed(2)} m — under the 1.05 m minimum. ` +
                      'Take a seat off each row, or narrow the aisles.');
    }
    if (layout.aisleM < MIN_GANGWAY) {
        problems.push(`Aisles are ${layout.aisleM.toFixed(2)} m — under the 1.05 m minimum.`);
    }
    if (geometry.crossAfter && geometry.crossWidthM < MIN_GANGWAY) {
        problems.push(`The cross gangway is ${geometry.crossWidthM.toFixed(2)} m — under the 1.05 m minimum.`);
    }
    if (layout.rearGangwayM < MIN_GANGWAY) {
        problems.push(`The gangway behind the last row is ${layout.rearGangwayM.toFixed(2)} m — under the 1.05 m minimum.`);
    }
    if (geometry.spareDepthM < 0) {
        problems.push(`The plan is ${Math.abs(geometry.spareDepthM).toFixed(2)} m longer than the hall. ` +
                      'Drop a row, or shorten the stage.');
    }
    if (layout.seat.pitchM < 0.75) {
        problems.push(`Rows are ${layout.seat.pitchM.toFixed(2)} m apart — too tight to get past seated people.`);
    }

    blocks.forEach((b, i) => {
        const aislesBothSides = i > 0 && i < blocks.length - 1;
        const max = aislesBothSides ? 14 : 7;
        if (b.seats > max) {
            problems.push(`${b.name} block has ${b.seats} seats in a row; the limit with ` +
                          `${aislesBothSides ? 'aisles both ends' : 'one aisle'} is ${max}.`);
        }
    });

    return {
        ok: problems.length === 0,
        problems,
        seats: map.total,
        seatsPerRow: map.seatsPerRow,
        rows: layout.rows,
        widthUsedM:   geometry.rowWidthM,
        depthUsedM:   geometry.depthUsedM,
        sideGangwayM: geometry.sideGangwayM,
        spareDepthM:  geometry.spareDepthM
    };
}

/**
 * How high the stage needs to be for the back row to see the actors' feet
 * over the heads in front, on a flat floor. Rough, but it is the number
 * that decides whether the plan works on the night.
 */
export function sightlines(map = SEAT_MAP) {
    const { layout, geometry } = map;
    const EYE = 1.20;                       // seated eye height
    const rearY = geometry.firstRowY + (layout.rows - 1) * layout.seat.pitchM + geometry.crossWidthM;
    return {
        rearRowDistanceM: Number(rearY.toFixed(2)),
        stageHeightM: layout.stage.heightM,
        // with every head in the way, you need this much stage to clear them
        clearHeadsHeightM: Number((EYE + 0.15).toFixed(2)),
        // staggering the rows lets you look between two heads instead of at one
        staggerRows: true,
        note: 'Flat floor: offset every second row by half a seat (0.25 m) so ' +
              'each person looks between the two heads in front, and keep the ' +
              'stage at least 1.1 m high. Anything past about row N wants tiering.'
    };
}

/* ------------------------------------------------------------- the map -- */

export const SEAT_MAP = buildSeatMap(LAYOUT);

/** Every seat id, in row then number order. */
export const SEAT_IDS = SEAT_MAP.seats.map(s => s.id);

const SEAT_ID_SET = new Set(SEAT_IDS);

/* --------------------------------------------------------------- tools -- */

/** Is this a seat that exists? */
export function isSeat(id) {
    return SEAT_ID_SET.has(String(id || '').trim().toUpperCase());
}

export function getSeat(id) {
    return SEAT_MAP.byId.get(String(id || '').trim().toUpperCase()) || null;
}

/** Row letter then seat number — the order a door list wants to be read in. */
export function compareSeats(a, b) {
    const sa = getSeat(a), sb = getSeat(b);
    if (!sa || !sb) return String(a).localeCompare(String(b));
    return sa.rowIndex - sb.rowIndex || sa.number - sb.number;
}

/**
 * Keep only real seats, once each, in reading order. Anything the browser
 * invents falls out here, which is why the server runs it too.
 */
export function cleanSeats(list, { max = 0 } = {}) {
    const raw = Array.isArray(list) ? list : String(list || '').split(',');
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        const id = String(item || '').trim().toUpperCase();
        if (SEAT_ID_SET.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    out.sort(compareSeats);
    return max > 0 ? out.slice(0, max) : out;
}

/** 'A1,A2,A3' -> 'Row A, seats 1–3'. What goes on the ticket email. */
export function describeSeats(list) {
    const ids = cleanSeats(list);
    if (!ids.length) return '';

    const byRow = new Map();
    for (const id of ids) {
        const s = getSeat(id);
        if (!byRow.has(s.row)) byRow.set(s.row, []);
        byRow.get(s.row).push(s.number);
    }

    const parts = [];
    for (const [row, numbers] of byRow) {
        numbers.sort((a, b) => a - b);
        // run the consecutive ones together: 4, 5, 6 reads as 4–6
        const runs = [];
        let start = numbers[0], prev = numbers[0];
        for (let i = 1; i <= numbers.length; i++) {
            if (numbers[i] === prev + 1) { prev = numbers[i]; continue; }
            runs.push(start === prev ? String(start) : `${start}–${prev}`);
            start = prev = numbers[i];
        }
        parts.push(`Row ${row}, seat${numbers.length === 1 ? '' : 's'} ${runs.join(', ')}`);
    }
    return parts.join(' · ');
}

/**
 * Pick the best `quantity` free seats, keeping the party together.
 *
 * Used when nobody chose for themselves — a cash sale at the door, or the
 * suggestion the booking page starts you off with. Preferences, in order:
 * sit together in one block, near the middle of the row, a good way back
 * from the stage but not at the very back.
 *
 * Returns [] if it cannot seat the party at all; returns a split-up party
 * only when no single run is long enough anywhere.
 */
export function allocateSeats(quantity, takenIds = [], { preferBlock = null, map = SEAT_MAP } = {}) {
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return [];

    const taken = takenIds instanceof Set ? takenIds : new Set(cleanSeats(takenIds));
    const idealRow = Math.max(0, Math.round(map.layout.rows * 0.3) - 1);
    const runs = [];

    for (const row of map.rows) {
        for (const block of map.blocks) {
            const inBlock = row.seats.filter(s => s.blockId === block.id);

            for (let start = 0; start + qty <= inBlock.length; start++) {
                const run = inBlock.slice(start, start + qty);
                if (run.some(s => taken.has(s.id))) continue;

                // middle of the run against the middle of the whole row
                const centre = (run[0].number + run[run.length - 1].number) / 2;
                const rowCentre = (map.seatsPerRow + 1) / 2;

                let score = Math.abs(row.index - idealRow) * 2
                          + Math.abs(centre - rowCentre) * 0.6;
                if (preferBlock && block.id !== preferBlock) score += 100;
                else if (!preferBlock && block.id !== 'C') score += 3;

                // leaving a single seat stranded beside the run wastes it
                const before = inBlock[start - 1];
                const after  = inBlock[start + qty];
                if (before && !taken.has(before.id) && (start === 1)) score += 1.5;
                if (after && !taken.has(after.id) && (start + qty === inBlock.length - 1)) score += 1.5;

                runs.push({ score, ids: run.map(s => s.id) });
            }
        }
    }

    if (runs.length) {
        runs.sort((a, b) => a.score - b.score);
        return runs[0].ids;
    }

    // Nothing long enough left — take the best singles we can and say so by
    // simply returning fewer than asked if the night is genuinely that full.
    if (preferBlock) return allocateSeats(qty, taken, { map });

    const free = map.seats.filter(s => !taken.has(s.id));
    return free.slice(0, qty).map(s => s.id).sort(compareSeats);
}

/** Everything a page needs to draw the map, without importing the whole module. */
export const SEATING = {
    LAYOUT, SEAT_MAP, SEAT_IDS,
    buildSeatMap, rowLetters, checkFit, sightlines,
    isSeat, getSeat, compareSeats, cleanSeats, describeSeats, allocateSeats
};

if (typeof window !== 'undefined') window.SEATING = SEATING;

export default SEATING;
