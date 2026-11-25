/* ==========================================================================
   MAMMA MIA! — St Mary's Edenderry
   Central configuration.  Edit this file to change show details.
   ==========================================================================

   >>> BEFORE GOING LIVE, CHECK EVERY VALUE MARKED  // TODO  <<<
   ========================================================================== */

const CONFIG = {

    /* --- Show ---------------------------------------------------------- */
    show: {
        title:      'Mamma Mia!',
        subtitle:   'The Musical',
        school:     "St Mary's Secondary School, Edenderry",
        year:       2027,
        venue:      "St Mary's Secondary School, Edenderry",
        venueLine2: 'Co. Offaly',
        // Google Maps link used on the home page
        venueMapUrl: 'https://www.google.com/maps/search/?api=1&query=St+Mary%27s+Secondary+School+Edenderry',
        doorsTime:  '7:00 PM',                               // TODO confirm
        startTime:  '7:30 PM',                               // TODO confirm
        // Questions go through the form on contact.html, which emails the
        // show inbox (ENQUIRIES_TO in Vercel, default smemammamia@proton.me).
        contactPage: 'contact.html'
    },

    /* --- Tickets ------------------------------------------------------- */
    ticket: {
        // Prices are set in Vercel (TICKET_PRICE, STUDENT_PRICE, CHILD_PRICE,
        // CHILD_AGE) and reach every page through /prices.js, loaded just
        // before this file. These numbers are only the fallback if that fails.
        price: 15,                    // euro, Standard
        studentPrice: 10,             // euro, SME Student
        childPrice: 10,               // euro, Child
        childAge: 10,                 // Child tickets are for under-10s
        studentLabel: 'SME student',      // in price lines: '€10 for SME students'
        // The ticket types, as printed on tickets and the booking summary.
        types: { student: 'SME Student', child: 'Child', standard: 'Standard' },
        qrLogo: 'images/crest-qr.png',  // shown in the middle of every QR ticket
        studentDomain: 'stmarysedenderry.ie', // student tickets need a school email here
                                      // (STUDENT_EMAIL_DOMAIN in Vercel, if set)
        currency: 'EUR',
        maxPerBooking: 10,            // most seats one person can pick in one booking
                                      // (must match MAX_PER_ORDER in Vercel, default 10)
        holdMinutes: 15               // how long tickets are reserved during checkout
    },

    /* --- Accessibility --------------------------------------------------
       The question asked at the details step of booking.html. `code` is
       what gets stored on the booking (never the label), so these labels
       can be reworded without touching any data already taken.

       `publicForm: false` keeps an option off the public booking form but
       on the admin Add booking form. Wheelchair spaces are arranged through
       an access request instead ("Need accessible seating?" by the plan),
       so the team can seat the party — the accessible seats themselves are
       listed in seating.js.

       >>> KEEP IN SYNC WITH api/_show.js — the browser reads this list,
           the server validates against that one. <<<
       ------------------------------------------------------------------- */
    accessOptions: [
        { code: 'wheelchair', label: 'Wheelchair space', publicForm: false },
        { code: 'aisle',      label: 'Aisle seat or extra legroom' },
        { code: 'hearing',    label: 'Hearing support' },
        { code: 'other',      label: 'Something else' }
    ],

    /* --- Performances --------------------------------------------------
       key       : ISO date, used in URLs (booking.html?date=...)
       label     : shown to the public
       short     : shown on compact cards

       There is no capacity here: every night has the seats in seating.js,
       less the accessible seats not released, less any blocked in admin.

       Only nights on public sale belong in this list — every page builds its
       dates from it.  See README.md for the full run.
       ------------------------------------------------------------------- */
    performances: [
        {
            key: '2027-01-28',
            label: 'Thursday 28th January 2027',
            short: 'Thu 28 Jan'
        },
        {
            key: '2027-01-29',
            label: 'Friday 29th January 2027',
            short: 'Fri 29 Jan'
        }
    ],

    /* --- What to say while booking is closed -----------------------------
       Used by index.html and booking.html whenever features.bookingOpen is
       false, so the wording lives in one place rather than being buried in
       two pages. The old copy said "not open yet", which is wrong for a
       pause — people had already been booking.
       -------------------------------------------------------------------- */
    closedNotice: {
        heading: 'Tickets on sale after lunch Monday 30-Nov',
        body: ''
    },

    /* --- Backend --------------------------------------------------------
       No database keys live in this file.  Every read and write goes
       through the serverless functions in /api, which hold the secrets as
       Vercel environment variables:

           SUPABASE_URL
           SUPABASE_SERVICE_ROLE_KEY
           SUMUP_API_KEY
           SUMUP_MERCHANT_CODE
           ADMIN_PASSWORD

       See README.md for how to set them.
       ------------------------------------------------------------------- */
    api: {
        availability: '/api/availability',
        seats:        '/api/seats',
        accessRequest: '/api/access-request',
        checkout:     '/api/create-checkout',
        studentCode:  '/api/student-code',
        verify:       '/api/verify-payment',
        wall:         '/api/wall',
        photos:       '/api/photos',
        enquiries:    '/api/enquiries',
        donna:        '/api/donna',
        admin:        '/api/admin'
    },

    /* --- Feature switches ---------------------------------------------- */
    features: {
        /* >>> BOOKING PAUSE — set back to true to reopen sales. <<<
           There is a second switch that has to move with it: BOOKING_OPEN in
           api/_show.js. This one closes the pages; that
           one closes the door behind them, so a page somebody already had
           open cannot still push a booking through.

           Door and cash sales on the admin Add booking tab are deliberately
           unaffected — staff can still take a booking while the public
           cannot. */
        bookingOpen: false,         // set false to close sales entirely
        showWall: true,             // the message wall
        showGames: true,
        showQuiz: true,
        showPhotos: true,
        showCast: true,
        /* "Ask Donna", the chat bubble (donna.js). false hides it on every
           page. To stop her answering but keep the bubble, set DONNA_ENABLED
           to false in Vercel instead — see README, Step 3e. */
        showDonna: true
    },

    /* --- Photos page background music -------------------------------------
       Plays quietly behind the slideshow, only after a visitor taps "Music",
       and pauses when the slideshow scrolls out of view.

       aegean-breeze.mp3 was composed and synthesised for this site, so it is
       free to use. To swap in another licence-free track (e.g. from Pixabay
       Music), drop the MP3 in /audio, change `file`, and set loopStart and
       loopEnd to null so it loops from start to end.
       Set file to null to remove the Music button. */
    photoMusic: {
        file: 'audio/aegean-breeze.mp3',
        loopStart: 2.307664,          // seconds — this file is built to loop seamlessly here
        loopEnd: 76.152925,
        volume: 0.35                // 0–1; it's already mastered quietly
    }
};

/* --- Helpers used across pages ----------------------------------------- */

CONFIG.getPerformance = function (key) {
    return CONFIG.performances.find(p => p.key === key) || null;
};

/* The prices set in Vercel, from /prices.js (see api/availability.js). */
(function () {
    const p = typeof window !== 'undefined' && window.SITE_PRICES;
    if (!p) return;
    const ok = v => typeof v === 'number' && isFinite(v) && v >= 0;
    if (ok(p.standard)) CONFIG.ticket.price = p.standard;
    if (ok(p.student))  CONFIG.ticket.studentPrice = p.student;
    if (ok(p.child))    CONFIG.ticket.childPrice = p.child;
    if (ok(p.childAge) && p.childAge > 0) CONFIG.ticket.childAge = p.childAge;
})();

CONFIG.money = function (n) {
    return '€' + Number(n).toFixed(2).replace(/\.00$/, '');
};

/** What `quantity` tickets cost when `students` of them are student tickets. */
CONFIG.priceFor = function (quantity, students = 0, children = 0) {
    const T = CONFIG.ticket;
    return (quantity - students - children) * T.price + students * T.studentPrice + children * T.childPrice;
};

/** '3 tickets (1 SME Student, 1 Child)' */
CONFIG.ticketWords = function (quantity, students = 0, children = 0) {
    const base = quantity + (quantity === 1 ? ' ticket' : ' tickets');
    const parts = [];
    if (students) parts.push(`${students} ${CONFIG.ticket.types.student}`);
    if (children) parts.push(`${children} ${children === 1 ? CONFIG.ticket.types.child : 'Children'}`);
    return parts.length ? `${base} (${parts.join(', ')})` : base;
};

/** 'under 10s' */
CONFIG.childWords = function () {
    return `under ${CONFIG.ticket.childAge}s`;
};

/** The three prices, as shown on the site: [['Standard', '€15'], ['SME students', '€10'], ['Under 10s', '€10']] */
CONFIG.priceItems = function () {
    const T = CONFIG.ticket, m = CONFIG.money;
    return [
        [T.types.standard, m(T.price)],
        ['SME students', m(T.studentPrice)],
        [`Under ${T.childAge}s`, m(T.childPrice)]
    ];
};

/** 'Standard €15 · SME students €10 · Under 10s €10' */
CONFIG.priceLine = function () {
    return CONFIG.priceItems().map(([label, price]) => `${label} ${price}`).join(' · ');
};

/** Turn stored access codes ('wheelchair,aisle') into readable labels. */
CONFIG.accessLabels = function (codes) {
    const list = Array.isArray(codes) ? codes : String(codes || '').split(',');
    return list
        .map(c => String(c).trim())
        .filter(Boolean)
        .map(c => {
            const opt = CONFIG.accessOptions.find(o => o.code === c);
            return opt ? opt.label : c;
        });
};

/** Booking reference, e.g. MM-4F2K9A */
CONFIG.newBookingRef = function () {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
    let out = '';
    const rnd = new Uint32Array(6);
    crypto.getRandomValues(rnd);
    for (let i = 0; i < 6; i++) out += chars[rnd[i] % chars.length];
    return 'MM-' + out;
};

/** Ask the server how many tickets are left for each night. */
CONFIG.fetchAvailability = async function () {
    const res = await fetch(CONFIG.api.availability, { cache: 'no-store' });
    if (!res.ok) throw new Error('availability lookup failed');
    return res.json(); // { '2027-01-28': { capacity, sold, remaining }, ... }
};

window.CONFIG = CONFIG;
