/* ==========================================================================
   MAMMA MIA! — drawing the hall plan
   ==========================================================================

   One renderer for every page that shows the hall: the booking page, the
   admin seat map and seat picker, the printed seat plan and seating.html.
   It knows nothing about the hall itself — every row, aisle, exit and
   toilet comes from seating.js, so a change there redraws all of them.

   Seats are real buttons in a CSS grid, not pictures, so a keyboard and a
   screen reader can use the plan:
     · one seat is in the tab order at a time; the arrow keys move around
       the hall (across aisles, over the cross aisle), Home and End go to
       the ends of a row, Enter or Space picks
     · every seat carries a label the page writes, e.g.
       "Row F, seat 12, available"
     · unavailable seats stay focusable (aria-disabled) so they are read
       out rather than silently skipped

   On a phone the plan is wider than the screen: it pans inside its own box,
   and the zoom buttons go from the whole hall to seats big enough to tap.
   ========================================================================== */

import { SEAT_MAP, buildLayout } from './seating.js';

const RUNNING_MAN =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="14.5" cy="3.6" r="2.3"/>' +
    '<path d="M9.3 8.4l4-1.6c.9-.4 1.9 0 2.4.8l1.4 2.6 3 1.2-.7 1.8-3.6-1.4-.9-1.6-1.3 3.6 2.8 2.6.4 6h-2.1l-.4-5.1-3-2.4-1.8 4.5-4.9 2.8-1-1.7 4.2-2.5 2.6-7.1-1.6.7-1.2 3H5.5l1.6-4.1z"/>' +
    '</svg>';

const FEMALE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="3.3" r="2.4"/>' +
    '<path d="M9.6 7h4.8l3.3 9.2h-3.2V23h-2V16.2h-1V23h-2v-6.8H6.3z"/>' +
    '</svg>';

const MALE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="3.3" r="2.4"/>' +
    '<path d="M8.6 7h6.8c.9 0 1.6.7 1.6 1.6V15h-2v8h-2.2v-7h-1.6v7H9v-8H7V8.6C7 7.7 7.7 7 8.6 7z"/>' +
    '</svg>';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const area = (r1, c1, r2, c2) => `grid-area:${r1}/${c1}/${r2}/${c2}`;

/**
 * Draw the plan into `container`.
 *
 * opts.interactive  seats are buttons (true) or plain cells (false)
 * opts.label        accessible name for the plan
 * opts.zoom         show the zoom controls (default: interactive)
 * opts.cell         starting seat size in px (default: fit on wide screens,
 *                   tappable on narrow ones)
 * opts.onSeat(id)   called when a seat is picked
 *
 * Returns a small controller: seat(id) gives the element, paint(fn) sets
 * every seat's state and label, focus(id), setCell(px), fit().
 */
export function drawSeatPlan(container, opts = {}) {
    const map = opts.map || SEAT_MAP;
    const L = buildLayout(map);
    const interactive = opts.interactive !== false;
    const showZoom = opts.zoom ?? interactive;

    const colTracks = L.cols.map(c => `calc(var(--cell) * ${c.size.toFixed(3)})`).join(' ');
    const rowTracks = L.rows.map(r => `calc(var(--cell) * ${r.size.toFixed(3)})`).join(' ');
    // + the padding round the grid (seatplan.css), which keeps the exit signs
    // on the outer walls from being clipped
    const PAD = 0.7;
    const unitsWide = L.cols.reduce((t, c) => t + c.size, 0) + 2 * PAD;
    const unitsHigh = L.rows.reduce((t, r) => t + r.size, 0) + 2 * PAD;

    const parts = [];
    const firstSeatRow = L.seatRow.get(map.rows[0].letter);
    const lastSeatRow  = L.seatRow.get(map.rows[map.rows.length - 1].letter) + 1;
    const inside = L.inside;

    // the hall itself, walls drawn as its border
    parts.push(`<div class="sp-hall" style="${area(L.hall.rowFrom, L.hall.colFrom, L.hall.rowTo, L.hall.colTo)}"></div>`);

    // backstage and stage, full width
    parts.push(`<div class="sp-backstage" style="${area(L.stage.backstage, inside.colFrom, L.stage.backstage + 1, inside.colTo)}"><span>Backstage</span></div>`);
    parts.push(`<div class="sp-stage" style="${area(L.stage.row, inside.colFrom, L.stage.row + 1, inside.colTo)}"><span>Stage</span></div>`);

    // walkways and aisles, in a soft tint
    parts.push(`<div class="sp-walk" style="${area(L.walkways.front, inside.colFrom, L.walkways.front + 1, inside.colTo)}"></div>`);
    parts.push(`<div class="sp-walk" style="${area(L.walkways.rear, inside.colFrom, L.walkways.rear + 1, inside.colTo)}"></div>`);
    if (L.walkways.cross) {
        parts.push(`<div class="sp-walk" style="${area(L.walkways.cross, inside.colFrom, L.walkways.cross + 1, inside.colTo)}"></div>`);
    }
    for (const c of [L.gangways.left, L.gangways.right, ...L.aisleCols]) {
        parts.push(`<div class="sp-walk" style="${area(firstSeatRow, c, lastSeatRow, c + 1)}"></div>`);
    }

    // row letters, in both side gangways
    for (const row of map.rows) {
        const r = L.seatRow.get(row.letter);
        for (const c of [L.gangways.left, L.gangways.right]) {
            parts.push(`<div class="sp-rowlabel" aria-hidden="true" style="${area(r, c, r + 1, c + 1)}">${row.letter}</div>`);
        }
    }

    // toilets outside the wall, with a door mark on it
    for (const t of L.toilets) {
        const icon = t.kind === 'female' ? FEMALE : MALE;
        parts.push(`<div class="sp-door sp-door-v" aria-hidden="true" style="${area(t.row, t.doorCol, t.row + 1, t.doorCol + 1)}"></div>`);
        parts.push(`<div class="sp-wc sp-wc-${t.kind}" role="img" aria-label="${esc(t.label)}" title="${esc(t.label)}" ` +
                   `style="${area(t.row, t.col, t.row + 1, t.col + 1)}">${icon}</div>`);
    }

    // exits, sitting on the wall
    for (const e of L.exits) {
        parts.push(`<div class="sp-exit sp-exit-${e.orient}" role="img" aria-label="${esc(e.label)}" title="${esc(e.label)}" ` +
                   `style="${area(e.row, e.col, e.row + 1, e.col + 1)}">${RUNNING_MAN}</div>`);
    }

    // the seats
    const tag = interactive ? 'button' : 'div';
    for (const s of map.seats) {
        const r = L.seatRow.get(s.row), c = L.seatCol.get(s.number);
        parts.push(
            `<${tag} ${interactive ? 'type="button" tabindex="-1" ' : ''}class="sp-seat" data-seat="${s.id}" ` +
            `data-state="free"${s.accessible ? ' data-accessible="1"' : ''} ` +
            `style="${area(r, c, r + 1, c + 1)}"><span class="sp-num" aria-hidden="true">${s.number}</span></${tag}>`
        );
    }

    container.innerHTML =
        (showZoom ? `
        <div class="sp-tools" role="group" aria-label="Zoom the seating plan">
          <button type="button" class="sp-zoom" data-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" class="sp-zoom" data-zoom="fit">Whole hall</button>
          <button type="button" class="sp-zoom" data-zoom="in" aria-label="Zoom in">+</button>
        </div>` : '') +
        `<div class="sp-scroll">
           <div class="sp-grid" ${interactive ? 'role="group"' : 'role="img"'} aria-label="${esc(opts.label || 'Seating plan')}"
                style="grid-template-columns:${colTracks};grid-template-rows:${rowTracks}">
             ${parts.join('')}
           </div>
         </div>`;

    const scroll = container.querySelector('.sp-scroll');
    const grid = container.querySelector('.sp-grid');

    const seatEls = new Map();
    grid.querySelectorAll('.sp-seat').forEach(el => seatEls.set(el.dataset.seat, el));

    /* ---- zoom ---- */
    const MIN = 6, MAX = 44;
    const TAPPABLE = 28;            // a seat a thumb can hit
    let cell = 0;

    function setCell(px) {
        cell = Math.max(MIN, Math.min(MAX, px));
        grid.style.setProperty('--cell', cell.toFixed(2) + 'px');
        grid.classList.toggle('sp-small', cell < 17);
        grid.classList.toggle('sp-tiny', cell < 12);
    }

    /** The seat size at which the whole hall fits the box, both ways. */
    function fitCell() {
        const width = (scroll.clientWidth || container.clientWidth || 360) - 6;
        const maxH = parseFloat(getComputedStyle(scroll).maxHeight);
        const height = (Number.isFinite(maxH) ? maxH : Infinity) - 6;
        return Math.floor(Math.min(width / unitsWide, height / unitsHigh) * 100) / 100;
    }

    function fit() { setCell(fitCell()); }

    /** Zoom around what is in the middle of the box, so the place you were looking at stays put. */
    function zoomBy(factor) {
        const cx = (scroll.scrollLeft + scroll.clientWidth / 2) / (grid.offsetWidth || 1);
        const cy = (scroll.scrollTop + scroll.clientHeight / 2) / (grid.offsetHeight || 1);
        setCell(cell * factor);
        scroll.scrollLeft = cx * grid.offsetWidth - scroll.clientWidth / 2;
        scroll.scrollTop  = cy * grid.offsetHeight - scroll.clientHeight / 2;
    }

    // Start with the whole hall in view where the seats are still big enough
    // to click; on a phone, start at a size a thumb can hit and let it pan.
    const fitted = fitCell();
    setCell(opts.cell || (interactive && fitted < 20 ? TAPPABLE : Math.min(fitted, 34)));

    container.querySelectorAll('.sp-zoom').forEach(btn => btn.addEventListener('click', () => {
        const z = btn.dataset.zoom;
        if (z === 'in') zoomBy(1.35);
        else if (z === 'out') zoomBy(1 / 1.35);
        else fit();
    }));

    /* ---- picking and keyboard ---- */
    let current = null;

    function setCurrent(id, move = true) {
        const el = seatEls.get(id);
        if (!el || !interactive) return;
        if (current && seatEls.get(current)) seatEls.get(current).tabIndex = -1;
        current = id;
        el.tabIndex = 0;
        if (move) {
            el.focus({ preventScroll: true });
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    if (interactive) {
        setCurrent(map.rows[Math.min(4, map.rows.length - 1)].seats[Math.floor(map.seatsPerRow / 2) - 1].id, false);

        grid.addEventListener('click', e => {
            const el = e.target.closest('.sp-seat');
            if (!el) return;
            setCurrent(el.dataset.seat, false);
            if (opts.onSeat) opts.onSeat(el.dataset.seat, e);
        });

        grid.addEventListener('keydown', e => {
            const el = e.target.closest('.sp-seat');
            if (!el) return;
            const s = map.byId.get(el.dataset.seat);
            const row = map.rows[s.rowIndex];
            let next = null;

            switch (e.key) {
                case 'ArrowLeft':  next = row.seats[s.number - 2]; break;
                case 'ArrowRight': next = row.seats[s.number]; break;
                case 'ArrowUp':    next = map.rows[s.rowIndex - 1]?.seats[s.number - 1]; break;
                case 'ArrowDown':  next = map.rows[s.rowIndex + 1]?.seats[s.number - 1]; break;
                case 'Home':       next = row.seats[0]; break;
                case 'End':        next = row.seats[row.seats.length - 1]; break;
                default: return;
            }
            e.preventDefault();
            if (next) setCurrent(next.id);
        });
    }

    return {
        layout: L,
        grid,
        seat: id => seatEls.get(id),
        /** fn(seat) -> { state, label, text?, title? } for every seat. */
        paint(fn) {
            for (const s of map.seats) {
                const el = seatEls.get(s.id);
                const out = fn(s) || {};
                el.dataset.state = out.state || 'free';
                if (out.released) el.dataset.released = '1'; else delete el.dataset.released;
                if (interactive) {
                    el.setAttribute('aria-label', out.label || `Row ${s.row}, seat ${s.number}`);
                    el.setAttribute('aria-pressed', String(out.state === 'selected'));
                    if (out.disabled) el.setAttribute('aria-disabled', 'true');
                    else el.removeAttribute('aria-disabled');
                }
                if (out.title !== undefined) el.title = out.title;
                if (out.text !== undefined) el.querySelector('.sp-num').textContent = out.text;
            }
        },
        focus: id => setCurrent(id),
        /** Bring a seat into view without moving focus. */
        reveal(id) {
            const el = seatEls.get(id);
            if (!el) return;
            const box = scroll.getBoundingClientRect(), r = el.getBoundingClientRect();
            scroll.scrollLeft += (r.left + r.width / 2) - (box.left + box.width / 2);
            scroll.scrollTop  += (r.top + r.height / 2) - (box.top + box.height / 2);
        },
        setCell, fit,
        get cell() { return cell; }
    };
}
