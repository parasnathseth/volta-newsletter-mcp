// Shared name matching for the do-not-feature list. Used by the vetting rules and by the
// gate in save_edition, so both agree on what counts as "naming" someone.
//
// Matching ignores case, punctuation and extra spaces, and only matches whole words, so
// "Tidewater Maps" matches "tidewater maps," and "TIDEWATER   MAPS" but a short name like
// "Ada" does not match inside "Adaptive".

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** True when two names are the same after ignoring case, punctuation and spacing. */
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

/** Removes every mention of the given names from the text (used to keep a blocked name out of an otherwise fine item). */
export function removeNameMentions(text: string, names: string[]): string {
  let out = text ?? '';
  for (const name of names) {
    const words = name
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length || !words[0]) continue;
    out = out.replace(new RegExp(`\\b${words.join('[^\\p{L}\\p{N}]+')}\\b`, 'giu'), 'a Volta company');
  }
  return out;
}
