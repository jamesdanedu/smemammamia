// Word lists and text checks shared by the message wall and Donna.
//
// The wall uses BLOCKED as it always has. Donna gets the stricter checks
// below: a longer list, the usual disguises (f*ck, sh1t, f u c k), the
// personal-detail scrub that runs before anything is sent to DeepSeek, and
// a short list of phrases that mean somebody may need help, not a quip.

// light-touch filter — the admin page is the real moderation
export const BLOCKED = /\b(fuck|shit|bitch|cunt|bastard|wanker|slut|whore|nigg|fag)\b/i;

/* Donna's list. Whole words only, so Sussex, cocktail and Dickens pass. */
const DONNA_BLOCKED = new RegExp('\\b(' + [
    'fuck\\w*', 'f+u+c+k+', 'fck\\w*', 'fk', 'feck\\w*', 'shit\\w*', 'shite', 'bullshit',
    'bitch\\w*', 'cunt\\w*', 'bastard\\w*', 'wank\\w*', 'twat\\w*', 'prick', 'pricks',
    'dick\\w*head', 'dick', 'dicks', 'cock', 'cocks', 'knobhead', 'bollocks', 'arse', 'arsehole\\w*',
    'ass', 'asshole\\w*', 'piss\\w*', 'slut\\w*', 'whore\\w*', 'hoe', 'hoes', 'tit', 'tits', 'titties',
    'boob\\w*', 'pussy', 'pussies', 'vagina\\w*', 'penis\\w*', 'sex', 'sexy', 'sexual\\w*',
    'porn\\w*', 'nude\\w*', 'naked', 'horny', 'orgasm\\w*', 'erotic\\w*', 'rape\\w*', 'rapist',
    'blowjob\\w*', 'handjob\\w*', 'cum', 'cumming', 'jizz', 'milf', 'onlyfans', 'nsfw',
    'nigg\\w*', 'fag', 'fags', 'faggot\\w*', 'retard\\w*', 'spastic\\w*', 'paki', 'pakis', 'tranny',
    'nazi\\w*', 'hitler', 'kys', 'stfu', 'wtf', 'gtfo', 'cocaine', 'ketamine', 'mdma'
].join('|') + ')\\b', 'i');

const SPACED = /\b[a-z](?:[\s.\-_*]+[a-z]\b){2,}/g;

/* For spelled-out letters, where "you are a f u c k" squashes to "afuck"
   and a whole-word match would miss it. Short, unambiguous roots only. */
const CORE = /fuck|shit|cunt|bitch|dick|cock|pussy|porn|sex|nigg|slut|whore|wank|twat/;

const LEET = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b' };

/** Undo the common disguises so the word list can see through them. */
export function normalise(text) {
    let t = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    // f*ck, sh*t, c**t: a masked letter inside a word becomes a wildcard
    t = t.replace(/\b(f)[*#_.]+(c?k)\b/g, '$1uck')
         .replace(/\b(f)[*#_.]+(ck)\b/g, '$1u$2')
         .replace(/\b(sh)[*#_.]+(t)\b/g, '$1i$2')
         .replace(/\b(c)[*#_.]+(nt)\b/g, '$1u$2')
         .replace(/\b(c)[*#_.]{2,}(t)\b/g, '$1un$2');
    // sh1t, fvck, @ss — swap look-alike characters, but only inside words
    t = t.replace(/[a-z0-9!@$]+/g, w => /[a-z]/.test(w) ? w.replace(/[0-9!@$]/g, c => LEET[c] || c) : w)
         .replace(/fvck/g, 'fuck');
    // f u c k, f.u.c.k, s-h-i-t — three or more single letters in a row are one word
    t = t.replace(SPACED, m => m.replace(/[\s.\-_*]+/g, ''));
    // fuuuuck, shiiiit
    t = t.replace(/([a-z])\1{2,}/g, '$1$1');
    return t;
}

/** True when Donna should not answer this, or not say it. */
export function isRude(text) {
    const t = normalise(text);
    if (DONNA_BLOCKED.test(t) || DONNA_BLOCKED.test(t.replace(/([a-z])\1+/g, '$1'))) return true;
    const spaced = String(text || '').toLowerCase().match(SPACED) || [];
    return spaced.some(m => CORE.test(m.replace(/[^a-z]/g, '')));
}

/* Somebody who may be in trouble gets a straight, kind answer with numbers
   to ring — never a joke, and never the model. First person only, so
   "kill yourself" aimed at Donna is treated as rudeness, not distress. */
const DISTRESS = new RegExp([
    '\\b(kill|hurt|harm|cut|end)(ing|ting)? my ?self\\b',
    '\\bself[- ]?harm',
    '\\bsuicid',
    '\\b(i|i\'m|im|i am) (want|wanna|going|gonna) (to )?die\\b',
    '\\bwant to die\\b', '\\bwanna die\\b', '\\bdon\'?t want to (live|be alive|be here)\\b',
    '\\bno reason to live\\b', '\\bbetter off dead\\b', '\\bbetter off without me\\b',
    '\\b(i\'m|im|i am|i\'m being|i am being|being) (bullied|abused|hurt at home)\\b',
    '\\bsomeone (is )?(hurting|abusing|touching) me\\b',
    '\\b(i\'m|im|i am) (so )?(scared|afraid) (to go )?home\\b',
    '\\bnobody (cares|would care) (about me|if i)\\b'
].join('|'), 'i');

export function soundsLikeDistress(text) {
    return DISTRESS.test(String(text || '').toLowerCase().replace(/[’`]/g, '\''));
}

/* ---------------------------------------------------------------------------
   Personal details. Everything a visitor types goes to DeepSeek, so anything
   that identifies a person is taken out first. Over-scrubbing is fine: Donna
   has no use for any of it.
   --------------------------------------------------------------------------- */
const REMOVED = '[removed]';
const SCRUBS = [
    /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi,                     // emails
    /\bMM-?[A-Z0-9]{6}\b/gi,                                     // booking references
    /\b(?:[AC-FHKNPRTV-Y]\d{2}|D6W)\s?[0-9AC-FHKNPRTV-Y]{4}\b/gi, // Eircodes
    /(?:\+|00)\d[\d\s().-]{6,}\d/g,                              // international phone numbers
    /\b0\d[\d\s().-]{5,}\d\b/g,                                  // Irish phone numbers
    /\b\d[\d\s-]{6,}\d\b/g,                                      // any other long run of digits (cards, ids)
    /\bhttps?:\/\/\S+/gi,                                        // links (nothing to do with us)
    /@[a-z0-9_.]{2,}/gi                                          // social handles
];
/* "my name is Aoife Byrne" — the word after these phrases, and the next one
   too when it has a capital letter (a surname, not the rest of the question). */
const NAMED = /\b(my name is|my name's|i'm called|i am called|call me|my (?:mum|mam|mom|dad|da|sister|brother|friend|teacher)(?:'s name)? is|i live (?:in|at|on)|my address is|my school is)\s+([^\s,.!?]+)(\s+[^\s,.!?]+)?/gi;

/**
 * Take personal details out of a message.
 * Returns { text, removed } — `removed` counts what came out.
 */
export function scrubPersonal(input) {
    let removed = 0;
    let text = String(input || '');
    for (const re of SCRUBS) {
        text = text.replace(re, () => { removed++; return REMOVED; });
    }
    text = text.replace(NAMED, (_m, lead, _first, next = '') => {
        removed++;
        return `${lead} ${REMOVED}` + (/^\s+[A-Z]/.test(next) ? '' : next);
    });
    return { text, removed };
}

/** Was the message mostly personal details, with little else to answer? */
export function mostlyPersonal(scrubbed) {
    const left = scrubbed.text.split(REMOVED).join(' ').replace(/[^a-z]/gi, '');
    return scrubbed.removed > 0 && left.length < 12;
}
