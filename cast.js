/* ==========================================================================
   CAST & CREW — edit this file to update the cast page.

   ---------------------------------------------------------------------------
   NAMES WITH AN APOSTROPHE
   ---------------------------------------------------------------------------
   Wrap every name in DOUBLE quotes, the way they are below. Then apostrophes
   just work:

       { name: "James O'Sullivan",  role: "Sky",  photo: "" }      ✅ correct
       { name: 'James O'Sullivan',  role: 'Sky',  photo: '' }      ❌ breaks

   Single quotes end the text at the apostrophe, which breaks this whole file
   and leaves the cast page blank. Double quotes have no such problem, so use
   them for everything — O'Brien, O'Reilly, D'Arcy, Ó Súilleabháin and the rest.

   Accents and fadas are fine either way: Séan, Aoife Ní Bhriain, Niamh Ó Dálaigh.

   The one character to avoid inside a double-quoted name is a double quote
   itself. If you need a nickname in quotes, use the curly ones: "Seán “Sav”
   Savage" — or just leave them out.
   ---------------------------------------------------------------------------

   Drop each person's photo into the /images folder and put the file name in
   "photo". Leave "photo" empty and their initials show instead. Roles that
   aren't cast yet can stay as "TBC" and will show a star.
   ========================================================================== */

const CAST = {

    /* ---- Principals -------------------------------------------------- */
    principals: [
        { name: "Kitty Carey", role: "Sophie Sheridan",       photo: "" },
        { name: "Katieann Rowan", role: "Donna Sheridan",        photo: "" },
        { name: "Ozzie Moore", role: "Sam Carmichael",        photo: "" },
        { name: "Ollie Murphy", role: "Bill Austin",           photo: "" },
        { name: "Ben Callaghan", role: "Harry Bright",          photo: "" },
        { name: "Sean Usher", role: "Sky",                   photo: "" },
        { name: "Amelia Hayden", role: "Tanya",                 photo: "" },
        { name: "Jenny Brady", role: "Rosie",                 photo: "" },
        { name: "TBC", role: "Lisa",                  photo: "" },
        { name: "Luisa Minciuna", role: "Ali",                   photo: "" },
        { name: "Alfie Cleary", role: "Pepper",                photo: "" },
        { name: "Bobby Nolan", role: "Eddie",                 photo: "" },
        { name: "TBC", role: "Father Alexandrios",    photo: "" }
    ],

    /* ---- Ensemble ------------------------------------------------------
       Just a list of names. Double quotes here too.
           "Aoife Ní Bhriain", "James O'Sullivan", "Cara Byrne",
       -------------------------------------------------------------------- */
    ensemble: [
        "Names to be announced"
    ],

    /* ---- Production team --------------------------------------------- */
    crew: [
        { name: "Collette McEntee", role: "Director",            photo: "" },
        { name: "Robyn Duke", role: "Choreographer",       photo: "" },
        { name: "TBC", role: "Producer",            photo: "" },
        { name: "Emmanuelle Galisson", role: "Stage Manager",       photo: "" },
        { name: "Ciaran Doyle", role: "Set Design & Construction",          photo: "" },
        { name: "James O'Sullivan", role: "IT, Lighting & Sound",    photo: "" },
        { name: "Leah Prendergast", role: "Costumes",            photo: "" },
        { name: "TBC", role: "Hair & Make-up",      photo: "" },
        { name: "TBC", role: "Front of House",      photo: "" }
    ]
};

window.CAST = CAST;
