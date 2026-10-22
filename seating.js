/* ==========================================================================
   MAMMA MIA! — St Mary's Edenderry
   The hall plan: one description of the seats, used everywhere.
   ==========================================================================

   The booking page, the admin seat map and picker, the printed seat plan,
   seating.html and the server-side checks are all built from this file.
   Change a value in PLAN and every one of them follows.

   >>> THE NUMBERS TO EDIT ARE ALL IN `PLAN`, DIRECTLY BELOW. <<<

   Loaded two ways, from this one file:
       browser   <script type="module"> import { SEAT_MAP } from './seating.js'
       server    import { SEAT_MAP } from '../seating.js'
   It also sets window.SEATING in a browser, for the console.

   The drawing is schematic, not to scale: every seat is one square, every
   aisle and walkway a fixed fraction of one. The stage is sized against the
   depth of the drawing so it reads about right.

   >>> Do not re-draw the plan once seats are sold. <<<
   Seat ids already on bookings (booking_seats) are not moved by a change
   here. Drop a row and somebody is holding a seat that is no longer on the
   map — and will not find it on the night.
   ========================================================================== */

export const PLAN = {

    /* --- Rows ------------------------------------------------------------
       Lettered from the stage back, skipping I and O (too easily read as
       1 and 0 on a printed list). 18 rows runs A to T.
       ------------------------------------------------------------------- */
    rows: 18,
    rowLetters: null,             // null = work them out: A, B, … skipping I and O

    /* --- Seats across ----------------------------------------------------
       Numbered 1 upwards from left to right as you face the stage, straight
       across both blocks. The centre aisle runs between the blocks.
       ------------------------------------------------------------------- */
    blocks: [
        { id: 'L', name: 'Left',  seats: 14 },    // seats 1–14
        { id: 'R', name: 'Right', seats: 14 }     // seats 15–28
    ],

    /* --- Aisles and walkways --------------------------------------------
       In seat-widths, for the drawing only. The cross aisle sits after the
       row named; null for none.
       ------------------------------------------------------------------- */
    crossAisleAfter: 'J',         // between row J and row K
    centreAisle:     1.0,
    crossAisle:      1.0,
    sideGangway:     1.0,         // along both side walls
    frontWalkway:    1.2,         // between the stage and row A
    rearWalkway:     1.2,         // behind the last row

    /* --- Stage -----------------------------------------------------------
       Full width of the hall, at the top of the plan. `depthShare` is the
       share of the hall's depth the stage takes, backstage strip included.
       ------------------------------------------------------------------- */
    stage: {
        depthShare:     0.225,
        backstageShare: 0.25      // of the stage depth, behind the performing area
    },

    /* --- Accessible seating ---------------------------------------------
       Not on public sale. Shown in their own colour; anyone who needs one
       sends an access request and the team assigns seats. An admin can
       release them to general sale, night by night.

       A wheelchair space takes the place of two seats with the chairs
       taken away, and a companion sits alongside. The team arranges that
       when they assign seats — the site only records which seats are used.
       ------------------------------------------------------------------- */
    accessibleSeats: [
        'J1', 'J2', 'J13', 'J14', 'J15', 'J16', 'J27', 'J28',
        'K1', 'K2', 'K13', 'K14', 'K15', 'K16', 'K27', 'K28'
    ],

    /* --- Exits -----------------------------------------------------------
       wall:  'top' (the stage end), 'bottom' (the back), 'left' or 'right'.
       at:    on a top or bottom wall, 'left' or 'right' end;
              on a side wall, a row letter or 'stage', 'front', 'cross', 'rear'.
       ------------------------------------------------------------------- */
    exits: [
        { wall: 'top',    at: 'right', label: 'Exit (backstage)' },
        { wall: 'bottom', at: 'right', label: 'Exit' },
        { wall: 'left',   at: 'S',     label: 'Exit' }
    ],

    /* --- Toilets ---------------------------------------------------------
       Drawn outside the side wall named, with a door mark on the wall.
       `at` works as it does for exits on a side wall.
       ------------------------------------------------------------------- */
    toilets: [
        { kind: 'female', wall: 'left', at: 'K',     label: 'Female toilets' },
        { kind: 'male',   wall: 'left', at: 'front', label: 'Male toilets' }
    ]
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

/** Every seat, row by row, plus the lookups the rest of the site needs. */
export function buildSeatMap(plan = PLAN) {
    const letters     = plan.rowLetters || rowLetters(plan.rows);
    const seatsPerRow = plan.blocks.reduce((t, b) => t + b.seats, 0);
    const crossIndex  = plan.crossAisleAfter ? letters.indexOf(plan.crossAisleAfter) : -1;
    const accessible  = new Set(plan.accessibleSeats || []);

    const rows = [];
    const seats = [];
    const byId = new Map();

    for (let r = 0; r < plan.rows; r++) {
        const letter = letters[r];
        const half = crossIndex >= 0 && r > crossIndex ? 'rear' : 'front';
        const rowSeats = [];
        let number = 0;

        plan.blocks.forEach((block, b) => {
            for (let i = 0; i < block.seats; i++) {
                number += 1;
                const id = letter + number;
                const s = {
                    id,
                    row: letter,
                    rowIndex: r,
                    number,
                    blockId: block.id,
                    blockIndex: b,
                    blockName: block.name,
                    seatInBlock: i + 1,
                    accessible: accessible.has(id),
                    half
                };
                seats.push(s);
                rowSeats.push(s);
                byId.set(id, s);
            }
        });

        rows.push({ letter, index: r, seats: rowSeats, half });
    }

    return {
        plan,
        rows,
        seats,
        byId,
        blocks: plan.blocks.map(b => ({ ...b })),
        letters,
        seatsPerRow,
        crossIndex,
        total: seats.length,
        accessibleIds: seats.filter(s => s.accessible).map(s => s.id)
    };
}

/**
 * Where everything goes on the drawing, as a grid of tracks.
 *
 * Every page draws from this, so a change to PLAN moves the aisles, the
 * stage, the exits and the toilets everywhere at once. Sizes are in
 * seat-widths; the page decides how big a seat-width is.
 *
 *   cols  [toilets][wall][gangway][block][aisle][block]…[gangway][wall]
 *   rows  [wall][backstage][stage][walkway][rows…][cross][rows…][walkway][wall]
 */
export function buildLayout(map = SEAT_MAP) {
    const { plan } = map;
    const WALL = 0.18;
    const OUTSIDE = 2.2;               // room outside the wall for the toilet symbols

    const cols = [];
    const addCol = (kind, size, extra = {}) => { cols.push({ kind, size, ...extra }); return cols.length; };

    const hasLeftToilets  = (plan.toilets || []).some(t => t.wall === 'left');
    const hasRightToilets = (plan.toilets || []).some(t => t.wall === 'right');

    const colOutsideLeft = addCol('outside', hasLeftToilets ? OUTSIDE : 0.6);
    const colWallLeft    = addCol('wall', WALL);
    const colGangLeft    = addCol('gangway', plan.sideGangway);

    const seatCol = new Map();          // seat number -> grid column
    let number = 0;
    const blockSpans = [];
    plan.blocks.forEach((block, b) => {
        if (b > 0) addCol('aisle', plan.centreAisle);
        const first = cols.length + 1;
        for (let i = 0; i < block.seats; i++) {
            number += 1;
            seatCol.set(number, addCol('seat', 1, { number }));
        }
        blockSpans.push({ id: block.id, from: first, to: cols.length + 1 });
    });

    const colGangRight    = addCol('gangway', plan.sideGangway);
    const colWallRight    = addCol('wall', WALL);
    const colOutsideRight = addCol('outside', hasRightToilets ? OUTSIDE : 0.6);

    /* ---- rows ---- */
    const seatArea = map.rows.length + plan.frontWalkway + plan.rearWalkway +
                     (map.crossIndex >= 0 ? plan.crossAisle : 0);
    // stage / (stage + seat area) = depthShare
    const stageTotal = seatArea * plan.stage.depthShare / (1 - plan.stage.depthShare);
    const backstage  = stageTotal * plan.stage.backstageShare;
    const stage      = stageTotal - backstage;

    const rowsOut = [];
    const addRow = (kind, size, extra = {}) => { rowsOut.push({ kind, size, ...extra }); return rowsOut.length; };

    const rowWallTop   = addRow('wall', WALL);
    const rowBackstage = addRow('backstage', backstage);
    const rowStage     = addRow('stage', stage);
    const rowFront     = addRow('walkway', plan.frontWalkway, { name: 'front' });

    const seatRow = new Map();          // row letter -> grid row
    let rowCross = null;
    map.rows.forEach(r => {
        seatRow.set(r.letter, addRow('seats', 1, { letter: r.letter }));
        if (r.index === map.crossIndex) rowCross = addRow('cross', plan.crossAisle, { name: 'cross' });
    });

    const rowRear       = addRow('walkway', plan.rearWalkway, { name: 'rear' });
    const rowWallBottom = addRow('wall', WALL);

    const lastCol = cols.length + 1;    // grid line after the last column
    const lastRow = rowsOut.length + 1;

    /** A side-wall position ('K', 'front', 'stage', 'cross', 'rear') -> grid row. */
    const sideRow = at => {
        if (seatRow.has(at)) return seatRow.get(at);
        return { stage: rowStage, front: rowFront, cross: rowCross || rowFront, rear: rowRear }[at] || rowFront;
    };

    const exits = (plan.exits || []).map(e => {
        if (e.wall === 'top' || e.wall === 'bottom') {
            const row = e.wall === 'top' ? rowWallTop : rowWallBottom;
            const col = e.at === 'left' ? colGangLeft : colGangRight;
            return { ...e, row, col, orient: 'h' };
        }
        const col = e.wall === 'left' ? colWallLeft : colWallRight;
        return { ...e, row: sideRow(e.at), col, orient: 'v' };
    });

    const toilets = (plan.toilets || []).map(t => {
        const row = sideRow(t.at);
        return {
            ...t,
            row,
            col: t.wall === 'right' ? colOutsideRight : colOutsideLeft,
            doorCol: t.wall === 'right' ? colWallRight : colWallLeft
        };
    });

    return {
        cols, rows: rowsOut, lastCol, lastRow,
        seatCol, seatRow, blockSpans,
        hall: { colFrom: colWallLeft, colTo: colWallRight + 1, rowFrom: rowWallTop, rowTo: rowWallBottom + 1 },
        inside: { colFrom: colGangLeft, colTo: colGangRight + 1 },
        stage: { row: rowStage, backstage: rowBackstage },
        walkways: { front: rowFront, rear: rowRear, cross: rowCross },
        gangways: { left: colGangLeft, right: colGangRight },
        aisleCols: cols.map((c, i) => c.kind === 'aisle' ? i + 1 : null).filter(Boolean),
        exits, toilets
    };
}

/* ------------------------------------------------------------- the map -- */

export const SEAT_MAP = buildSeatMap(PLAN);

/** Every seat id, in row then number order. */
export const SEAT_IDS = SEAT_MAP.seats.map(s => s.id);

/** The accessible seats, which are never on public sale unless released. */
export const ACCESSIBLE_IDS = SEAT_MAP.accessibleIds;

const SEAT_ID_SET = new Set(SEAT_IDS);
const ACCESSIBLE_SET = new Set(ACCESSIBLE_IDS);

/* --------------------------------------------------------------- tools -- */

const norm = id => String(id || '').trim().toUpperCase();

/** Is this a seat that exists? */
export function isSeat(id) {
    return SEAT_ID_SET.has(norm(id));
}

export function getSeat(id) {
    return SEAT_MAP.byId.get(norm(id)) || null;
}

export function isAccessible(id) {
    return ACCESSIBLE_SET.has(norm(id));
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
        const id = norm(item);
        if (SEAT_ID_SET.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    out.sort(compareSeats);
    return max > 0 ? out.slice(0, max) : out;
}

/** 'K5,K6,K7,K8' -> 'Row K, seats 5–8'. What goes on the ticket email. */
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
 * Seats a member of the public may not buy on a given night: the accessible
 * seats that have not been released. The server passes this to create_hold,
 * so the rule is enforced in the database from the one list in PLAN.
 */
export function restrictedSeats(releasedIds = []) {
    const released = new Set(cleanSeats(releasedIds));
    return ACCESSIBLE_IDS.filter(id => !released.has(id));
}

/** Seats on public sale for a night: everything, less accessible-not-released, less blocked. */
export function sellableCount({ released = [], blocked = [] } = {}) {
    const off = new Set([...restrictedSeats(released), ...cleanSeats(blocked)]);
    return SEAT_MAP.total - off.size;
}

/**
 * Pick the best `quantity` free seats, keeping the party together.
 *
 * Used for the "find me seats together" helper on the booking page and the
 * admin picker. `unavailable` is everything the party cannot have — sold,
 * held, blocked, and accessible seats unless the caller says otherwise.
 * Preferences, in order: one row, one block, about a third of the way back,
 * close to the centre aisle.
 *
 * Returns [] if no run is long enough anywhere: the person picks by hand.
 */
export function allocateSeats(quantity, unavailable = [], { map = SEAT_MAP } = {}) {
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return [];

    const taken = unavailable instanceof Set ? unavailable : new Set(cleanSeats(unavailable));
    const idealRow = Math.max(0, Math.round(map.rows.length * 0.3) - 1);
    const middle = (map.seatsPerRow + 1) / 2;
    let best = null;

    for (const row of map.rows) {
        for (const block of map.blocks) {
            const inBlock = row.seats.filter(s => s.blockId === block.id);

            for (let start = 0; start + qty <= inBlock.length; start++) {
                const run = inBlock.slice(start, start + qty);
                if (run.some(s => taken.has(s.id))) continue;

                const centre = (run[0].number + run[run.length - 1].number) / 2;
                let score = Math.abs(row.index - idealRow) * 2 + Math.abs(centre - middle) * 0.5;

                // leaving one seat stranded between the run and the end of the block wastes it
                const before = inBlock[start - 1], after = inBlock[start + qty];
                if (start === 1 && before && !taken.has(before.id)) score += 1.5;
                if (start + qty === inBlock.length - 1 && after && !taken.has(after.id)) score += 1.5;

                if (!best || score < best.score) best = { score, ids: run.map(s => s.id) };
            }
        }
    }
    return best ? best.ids : [];
}

/** Everything a page needs, without importing names one by one. */
export const SEATING = {
    PLAN, SEAT_MAP, SEAT_IDS, ACCESSIBLE_IDS,
    buildSeatMap, buildLayout, rowLetters,
    isSeat, getSeat, isAccessible, compareSeats, cleanSeats, describeSeats,
    restrictedSeats, sellableCount, allocateSeats
};

if (typeof window !== 'undefined') window.SEATING = SEATING;

export default SEATING;
