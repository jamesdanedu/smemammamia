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

   PHOTOS
   ---------------------------------------------------------------------------
   Drop each person's photo into the /images folder and put the file name in
   "photo". Leave "photo" empty and their initials show instead. Roles that
   aren't cast yet can stay as "TBC" and will show a star.

   Name the photo  Name_as_Role.jpg  (or .JPG, .png, .PNG) and the text under
   it is taken from the file name — real name first, then the role. Start
   each word with a capital letter and leave out the spaces; the page puts
   them back:

       { name: "TBC", role: "Sophie Sheridan",
         photo: "KittyCarey_as_SophieSheridan.png" }
           → shows  Kitty Carey  /  Sophie Sheridan

       { name: "TBC", role: "Sky",
         photo: "JohnMurphy_as_Sky.JPG" }              (one-word roles are fine)
           → shows  John Murphy  /  Sky

   Mc, Mac and O' names come out right: "ColletteMcEntee" → Collette McEntee,
   "JamesO'Sullivan" → James O'Sullivan. Underscores also work as spaces
   ("Kitty_Carey_as_Sophie_Sheridan.png") if you'd rather use them.

   When a photo is named that way, it wins over "name" and "role" here. A
   photo with any other file name leaves "name" and "role" as written.
   File names are case-sensitive on the live site, so type them exactly —
   "Sky.JPG" and "Sky.jpg" are different files.
   ========================================================================== */

const CAST = {

    /* ---- Principals -------------------------------------------------- */
    principals: [
        { name: "TBC", role: "Sophie Sheridan",       photo: "" },
        { name: "TBC", role: "Donna Sheridan",        photo: "" },
        { name: "TBC", role: "Sam Carmichael",        photo: "" },
        { name: "TBC", role: "Bill Austin",           photo: "" },
        { name: "TBC", role: "Harry Bright",          photo: "" },
        { name: "TBC", role: "Sky",                   photo: "" },
        { name: "TBC", role: "Tanya",                 photo: "" },
        { name: "TBC", role: "Rosie",                 photo: "" },
        { name: "TBC", role: "Lisa",                  photo: "" },
        { name: "TBC", role: "Ali",                   photo: "" },
        { name: "TBC", role: "Pepper",                photo: "" },
        { name: "TBC", role: "Eddie",                 photo: "" },
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
