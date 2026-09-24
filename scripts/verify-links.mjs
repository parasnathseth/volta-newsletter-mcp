// Checks that each source we cite for a newsletter is real: the page loads, and (when a quote
// is given) the quote actually appears on it. The server cannot open web pages, so this is how
// WE double-check a finished issue before it goes anywhere. It is a helper for us, not part of
// Bader's weekly flow.
//
// Usage:   node scripts/verify-links.mjs sources.json
// The file is a list:  [ { "url": "https://...", "quote": "text that should be on the page" }, ... ]
// "quote" is optional; without it only the page loading is checked.

import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 15_000;
const MAX_CHARS = 2_000_000; // stop reading a page after this much text

// Lowercase, drop tags, decode the few entities that matter, and collapse spacing, so a quote
// still matches when the page splits it across tags or lines.
function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Curly quotes and dashes in a copied quote should not stop it matching.
const plain = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

async function check({ url, quote }) {
  if (!/^https:\/\//i.test(url)) return { ok: false, note: 'not an https link' };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'volta-newsletter-link-check', accept: 'text/html,*/*' },
    });
    if (!res.ok) return { ok: false, note: `page answered HTTP ${res.status}` };
    if (!quote) return { ok: true, note: `loads (HTTP ${res.status})` };
    const text = pageText((await res.text()).slice(0, MAX_CHARS));
    return plain(quote) && text.includes(plain(quote)) ? { ok: true, note: 'loads and the quote is on the page' } : { ok: false, note: 'loads, but the quote was NOT found on the page' };
  } catch (err) {
    return { ok: false, note: `could not fetch: ${err.message}` };
  }
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/verify-links.mjs sources.json');
  process.exit(2);
}
const sources = JSON.parse(readFileSync(file, 'utf8'));
let bad = 0;
for (const source of sources) {
  const r = await check(source);
  if (!r.ok) bad += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${source.url}\n      ${r.note}`);
}
console.log(`\n${sources.length - bad} of ${sources.length} sources verified.`);
process.exit(bad ? 1 : 0);
