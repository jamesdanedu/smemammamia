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
        price: 15,                    // euro, flat rate for every ticket
        currency: 'EUR',
        maxPerBooking: 10,            // most tickets one person can buy at once
        holdMinutes: 15               // how long tickets are reserved during checkout
    },

    /* --- Performances --------------------------------------------------
       key       : ISO date, used in URLs (booking.html?date=...)
       label     : shown to the public
       short     : shown on compact cards
       capacity  : total tickets on sale for that night
       ------------------------------------------------------------------- */
    performances: [
        {
            key: '2027-01-27',
            label: 'Wednesday 27th January 2027',
            short: 'Wed 27 Jan',
            capacity: 500                                    // TODO confirm hall capacity
        },
        {
            key: '2027-01-28',
            label: 'Thursday 28th January 2027',
            short: 'Thu 28 Jan',
            capacity: 500                                    // TODO confirm hall capacity
        },
        {
            key: '2027-01-29',
            label: 'Friday 29th January 2027',
            short: 'Fri 29 Jan',
            capacity: 500                                    // TODO confirm hall capacity
        }
    ],

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
        checkout:     '/api/create-checkout',
        verify:       '/api/verify-payment',
        wall:         '/api/wall',
        enquiries:    '/api/enquiries',
        admin:        '/api/admin'
    },

    /* --- Feature switches ---------------------------------------------- */
    features: {
        bookingOpen: true,          // set false to close sales entirely
        showWall: true,             // the message wall
        showGames: true,
        showQuiz: true,
        showPhotos: true,
        showCast: true
    }
};

/* --- Helpers used across pages ----------------------------------------- */

CONFIG.getPerformance = function (key) {
    return CONFIG.performances.find(p => p.key === key) || null;
};

CONFIG.money = function (n) {
    return '€' + Number(n).toFixed(2).replace(/\.00$/, '');
};

CONFIG.totalCapacity = function () {
    return CONFIG.performances.reduce((t, p) => t + p.capacity, 0);
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
    return res.json(); // { '2027-01-27': { capacity, sold, remaining }, ... }
};

window.CONFIG = CONFIG;
