// Shared name matching for the do-not-feature list. Used by the vetting rules and by the
// gate in save_edition, so both agree on what counts as "naming" someone.
//
// Matching ignores case, accents, punctuation, extra spaces and invisible characters, and it
// reads HTML entities the way a browser would, so "Tidewater Maps" matches "tidewater maps,",
// "TIDEWATER   MAPS", "Tidew&#97;ter Maps", "Tide&shy;water Maps" and "Ｔidewater Maps". It only
// matches whole words, so a short name like "Ada" does not match inside "Adaptive".

// The named HTML entities worth decoding. (Accented letters such as &eacute; are handled in
// decodeEntities.) A Map, not a plain object, so "&constructor;" cannot find anything odd.
const NAMED = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '],
  ['shy', ''], ['zwnj', ''], ['zwj', ''],
  ['oslash', 'ø'], ['aelig', 'æ'], ['szlig', 'ß'],
]);

function decodeEntities(s: string): string {
  return s
    // &#97; and &#x61; (a browser accepts them without the closing ";" too). 0 or out of range becomes a space.
    .replace(/&#(?:(\d{1,7})|x([0-9a-f]{1,6}));?/gi, (_m, dec, hex) => {
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    // &eacute; &Ocirc; &ntilde; ...: the accent is dropped later anyway, so keep just the letter.
    .replace(/&([A-Za-z])(?:acute|grave|circ|uml|tilde|ring|cedil|caron);/g, '$1')
    .replace(/&([A-Za-z]{2,8});/g, (m, name: string) => NAMED.get(name.toLowerCase()) ?? m);
}

// One place that makes two texts comparable. The order matters: entities are decoded first,
// NFKC turns look-alikes such as fullwidth "Ｔ" into "T", lower-casing comes before the accents
// are split off (so a capital dotted I cannot bring one back), and invisible characters (\p{Cf}:
// zero-width, soft hyphen) and combining marks (\p{M}) are removed BEFORE everything else that is
// not a letter or digit becomes a space, so "Tide<soft hyphen>water" is still one word.
const normalize = (s: string) =>
  decodeEntities(s)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{Cf}\p{M}]+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** True when two names are the same after ignoring case, accents, punctuation and spacing. */
export function sameName(a: string, b: string): boolean {
  const x = normalize(a);
  return x !== '' && x === normalize(b);
}

/** Returns the names (as given) that appear as whole words in the text. */
export function findNameMentions(text: string, names: string[]): string[] {
  const haystack = ` ${normalize(text ?? '')} `;
  return names.filter((name) => {
    const n = normalize(name);
    return n !== '' && haystack.includes(` ${n} `);
  });
}

// removeNameMentions only ever reads this much of a text. Nothing this long is a real update, and
// cutting it keeps one huge input from making the server work for a long time. Cutting is safe:
// whatever is cut off is gone, so no mention can survive in it.
const MAX_REMOVE_CHARS = 50_000;
const WORD = '[\\p{L}\\p{N}]'; // one letter or digit, written for a RegExp built from a string
const NOT_WORD = '[^\\p{L}\\p{N}]';

/** Removes every mention of the given names from the text (used to keep a blocked name out of an otherwise fine item). */
export function removeNameMentions(text: string, names: string[]): string {
  let out = (text ?? '').slice(0, MAX_REMOVE_CHARS).normalize('NFC'); // NFC so "é" typed as one character or two still matches
  for (const name of names) {
    if (normalize(name).length < 2) continue; // a one-letter name would match the word "a" everywhere
    // The name's own letters and digits, in order, with any run of other characters allowed between
    // them ("Smith & Sons" and "smith-sons" both match). The edges use "not next to a letter or digit"
    // instead of \b, because \b only knows ASCII letters and fails for a name such as "Élise Roy".
    // Every part is plain letters or digits, so nothing needs escaping, and each gap sits between two
    // fixed words, which keeps the search linear (no catastrophic backtracking).
    const parts = name.normalize('NFC').match(/[\p{L}\p{N}]+/gu);
    if (!parts) continue;
    out = out.replace(new RegExp(`(?<!${WORD})${parts.join(`${NOT_WORD}+`)}(?!${WORD})`, 'giu'), 'a Volta company');
  }
  return out;
}
