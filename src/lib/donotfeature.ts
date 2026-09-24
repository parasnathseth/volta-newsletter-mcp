import { findNameMentions, sameName } from './nameMatch.ts';

// The do-not-feature list holds people and companies who asked NOT to be named in the
// newsletter. It wins over any consent: even if someone says "yes, they agreed", a name
// on this list cannot be saved into an edition or pushed to a Mailchimp draft.
//
// Storage: the whole list is ONE KV document read and written by exact key, the same
// pattern as backlog.ts. KV `list` is eventually consistent, so a name added a moment
// ago could be missing from a listing, and this list must never miss a name. The list is
// tiny (a handful of names), so one document is cheap.
//
// If the read fails (KV down, damaged document) the error is NOT swallowed: the caller
// fails, so a save or a draft is refused rather than let through unchecked.

export interface DoNotFeatureEntry {
  id: string;
  name: string; // a person or a company, as the editor typed it
  note: string; // why / who asked / when (optional, may be empty)
  addedAt: string;
  addedBy: string;
}

export interface DoNotFeatureEnv {
  OAUTH_KV: KVNamespace;
}

export class DoNotFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoNotFeatureError';
  }
}

const DOC_KEY = 'donotfeature:all';
const MIN_NAME = 2; // one letter would match far too much
const MAX_NAME = 100;
const MAX_NOTE = 500;
const MAX_ENTRIES = 500; // keeps the one document small

async function loadAll(env: DoNotFeatureEnv): Promise<DoNotFeatureEntry[]> {
  const doc = (await env.OAUTH_KV.get(DOC_KEY, 'json')) as { entries: DoNotFeatureEntry[] } | null;
  return doc?.entries ?? [];
}

const saveAll = (env: DoNotFeatureEnv, entries: DoNotFeatureEntry[]) => env.OAUTH_KV.put(DOC_KEY, JSON.stringify({ entries }));

/** The whole list. Other code (saveEdition, create_draft, vet_updates) imports this. */
export async function getDoNotFeature(env: DoNotFeatureEnv): Promise<DoNotFeatureEntry[]> {
  return loadAll(env);
}

export async function addDoNotFeature(env: DoNotFeatureEnv, input: { name: string; note?: string }, by: string): Promise<DoNotFeatureEntry> {
  const name = (input.name ?? '').trim();
  const note = (input.note ?? '').trim();
  if (name.length < MIN_NAME) throw new DoNotFeatureError('A name is required: the person or company that asked not to be featured.');
  if (name.length > MAX_NAME) throw new DoNotFeatureError(`The name is too long (max ${MAX_NAME} characters).`);
  // A name made only of symbols would never match anything, so it would protect nobody.
  if (!/[\p{L}\p{N}]/u.test(name)) throw new DoNotFeatureError('The name needs at least some letters or numbers.');
  if (note.length > MAX_NOTE) throw new DoNotFeatureError(`The note is too long (max ${MAX_NOTE} characters).`);

  const entries = await loadAll(env);
  if (entries.length >= MAX_ENTRIES) throw new DoNotFeatureError(`The list already has ${MAX_ENTRIES} names, which is the most it holds.`);
  const dup = entries.find((e) => sameName(e.name, name));
  if (dup) throw new DoNotFeatureError(`"${dup.name}" is already on the do-not-feature list (added ${dup.addedAt.slice(0, 10)}). It was not added again.`);

  const entry: DoNotFeatureEntry = { id: crypto.randomUUID(), name, note, addedAt: new Date().toISOString(), addedBy: by };
  await saveAll(env, [...entries, entry]);
  return entry;
}

/** Takes a name off the list. Returns what was removed (and who removed it) so it can be re-added if this was a mistake. */
export async function removeDoNotFeature(env: DoNotFeatureEnv, name: string, by: string): Promise<DoNotFeatureEntry & { removedBy: string; removedAt: string }> {
  const entries = await loadAll(env);
  const found = entries.find((e) => sameName(e.name, name ?? ''));
  if (!found) throw new DoNotFeatureError(`"${(name ?? '').slice(0, 100)}" is not on the do-not-feature list. do_not_feature_list shows who is on it.`);
  await saveAll(env, entries.filter((e) => e.id !== found.id));
  return { ...found, removedBy: by, removedAt: new Date().toISOString() };
}

// ---- The check --------------------------------------------------------------------

/** The parts of an edition (or of a save request) that the check reads. */
export interface DoNotFeatureCheckable {
  featured: { founder: string; company?: string; topic: string }[];
  bodyHtml: string;
}

/** What a list entry looks like to the check. Kept small so vet_updates can pass its own list in. */
export interface ListedName {
  name: string;
  note?: string;
  addedAt: string;
}

// Who asked, when, and what the editor wrote down. Every problem starts with this so the
// editor sees the reason, not just "blocked".
const why = (e: ListedName) => `${e.name} asked not to be featured (on the do-not-feature list since ${e.addedAt.slice(0, 10)}${e.note ? `; note: ${e.note}` : ''}).`;

// The words a reader could see in the email. Tags are removed first, so a name sitting
// inside <b>...</b> is still found, and tag or attribute text such as a colour never counts.
// Image alt text and title text are kept because they are read aloud or shown on hover.
// It returns two versions of the text on purpose: one where each tag becomes a space, and
// one where each tag becomes nothing (which catches a name cut in two by a tag, like
// Tide<b>water</b>). Checking both means a rare false alarm, and never a missed name.
function visibleTexts(html: string): string[] {
  const alt = [...html.matchAll(/\b(?:alt|title)\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2]).join(' ');
  // Every HTML entity (&amp; &nbsp; &#39; ...) becomes a space; name matching ignores punctuation anyway.
  const clean = (s: string) => s.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ');
  return [clean(html.replace(/<[^>]*>/g, ' ')) + ' ' + alt, clean(html.replace(/<[^>]*>/g, '')) + ' ' + alt];
}

/**
 * Plain-language problems if the edition names anyone on the list: in a featured story's
 * founder, company or topic, or anywhere in the visible text of the body. Empty means clean.
 */
export function doNotFeatureProblems(edition: DoNotFeatureCheckable, list: ListedName[]): string[] {
  const problems: string[] = [];
  const bodyTexts = visibleTexts(edition.bodyHtml ?? '');

  for (const entry of list) {
    for (const f of edition.featured ?? []) {
      // Each field is checked on its own so a name cannot be "found" by gluing two fields together.
      // findNameMentions also catches an exact match (founder "Tidewater Maps" against the name "Tidewater Maps").
      const named = [f.founder, f.company ?? '', f.topic].some((text) => findNameMentions(text, [entry.name]).length > 0);
      if (named) {
        const who = f.company ? `${f.founder}, ${f.company}` : f.founder;
        problems.push(`${why(entry)} The featured story "${f.topic}" (${who}) names them.`);
      }
    }
    if (bodyTexts.some((text) => findNameMentions(text, [entry.name]).length > 0)) {
      problems.push(`${why(entry)} The newsletter body names them.`);
    }
  }
  return problems;
}
