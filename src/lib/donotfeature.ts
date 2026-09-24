import { originFor } from './backlog.ts';
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
//
// Only the editor (EDITOR_EMAILS, see originFor in backlog.ts) may add or remove names.

export interface DoNotFeatureEntry {
  id: string;
  name: string; // a person or a company, as the editor typed it
  note: string; // why / who asked / when (optional, may be empty)
  addedAt: string;
  addedBy: string;
}

export interface DoNotFeatureEnv {
  OAUTH_KV: KVNamespace;
  EDITOR_EMAILS?: string; // unset means everyone counts as the editor, as in backlog.ts
}

export class DoNotFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoNotFeatureError';
  }
}

const DOC_KEY = 'donotfeature:all';
const MIN_NAME = 2; // one letter would match far too much
export const MAX_NAME = 100;
export const MAX_NOTE = 500;
const MAX_ENTRIES = 500; // keeps the one document small
const MAX_TRIES = 5; // how often an add or remove re-checks its own write (see below)

async function loadAll(env: DoNotFeatureEnv): Promise<DoNotFeatureEntry[]> {
  const doc = (await env.OAUTH_KV.get(DOC_KEY, 'json')) as { entries: DoNotFeatureEntry[] } | null;
  return doc?.entries ?? [];
}

const saveAll = (env: DoNotFeatureEnv, entries: DoNotFeatureEntry[]) => env.OAUTH_KV.put(DOC_KEY, JSON.stringify({ entries }));

/** The whole list. Other code (saveEdition, create_draft, vet_updates) imports this. */
export async function getDoNotFeature(env: DoNotFeatureEnv): Promise<DoNotFeatureEntry[]> {
  return loadAll(env);
}

// Whoever is not the editor may read the list but not change it.
function requireEditor(env: DoNotFeatureEnv, by: string): void {
  if (originFor(env, by) !== 'editor') throw new DoNotFeatureError('Only the editor can add or remove names on the do-not-feature list. Ask the editor to do it.');
}

// Workers KV cannot say "write only if nobody else wrote since I read", so two calls at the same
// moment can each read the old list and the last write wins, losing the other name. So every change
// checks its own work: it waits a moment (a random time, so calls that collided do not collide
// again), reads the list back, and tries again if its change is not there. This makes losing a
// name very unlikely; it cannot make it impossible. Changes are rare and the editor is one person.
const pause = () => new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));

const notConfirmed = (what: string) =>
  new DoNotFeatureError(`Could not confirm that ${what}: other changes to the list kept overwriting it. Check do_not_feature_list to see what is on it, then try again.`);

export async function addDoNotFeature(env: DoNotFeatureEnv, input: { name: string; note?: string }, by: string): Promise<DoNotFeatureEntry> {
  requireEditor(env, by);
  const name = (input.name ?? '').trim();
  const note = (input.note ?? '').trim();
  if (name.length < MIN_NAME) throw new DoNotFeatureError('A name is required: the person or company that asked not to be featured.');
  if (name.length > MAX_NAME) throw new DoNotFeatureError(`The name is too long (max ${MAX_NAME} characters).`);
  // A name made only of symbols would never match anything, so it would protect nobody.
  if (!/[\p{L}\p{N}]/u.test(name)) throw new DoNotFeatureError('The name needs at least some letters or numbers.');
  if (note.length > MAX_NOTE) throw new DoNotFeatureError(`The note is too long (max ${MAX_NOTE} characters).`);

  const entry: DoNotFeatureEntry = { id: crypto.randomUUID(), name, note, addedAt: new Date().toISOString(), addedBy: by };
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const entries = await loadAll(env);
    if (entries.some((e) => e.id === entry.id)) return entry; // read back after our own write: it is there
    if (entries.length >= MAX_ENTRIES) throw new DoNotFeatureError(`The list already has ${MAX_ENTRIES} names, which is the most it holds.`);
    const dup = entries.find((e) => sameName(e.name, name));
    if (dup) throw new DoNotFeatureError(`"${dup.name}" is already on the do-not-feature list (added ${dup.addedAt.slice(0, 10)}). It was not added again.`);
    await saveAll(env, [...entries, entry]);
    await pause();
  }
  if ((await loadAll(env)).some((e) => e.id === entry.id)) return entry; // the last try's read-back
  throw notConfirmed(`"${name}" was added`);
}

/** Takes a name off the list. Returns what was removed (and who removed it) so it can be re-added if this was a mistake. */
export async function removeDoNotFeature(env: DoNotFeatureEnv, name: string, by: string): Promise<DoNotFeatureEntry & { removedBy: string; removedAt: string }> {
  requireEditor(env, by);
  const result = (e: DoNotFeatureEntry) => ({ ...e, removedBy: by, removedAt: new Date().toISOString() });
  let removed: DoNotFeatureEntry | undefined; // set once we have written a list without it
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const entries = await loadAll(env);
    const found = entries.find((e) => (removed ? e.id === removed.id : sameName(e.name, name ?? '')));
    if (!found) {
      if (removed) return result(removed); // read back after our own write: it is gone
      throw new DoNotFeatureError(`"${(name ?? '').slice(0, 100)}" is not on the do-not-feature list. do_not_feature_list shows who is on it.`);
    }
    removed = found;
    await saveAll(env, entries.filter((e) => e.id !== found.id));
    await pause();
  }
  if (removed && !(await loadAll(env)).some((e) => e.id === removed!.id)) return result(removed); // the last try's read-back
  throw notConfirmed(`"${(name ?? '').slice(0, 100)}" was removed`);
}

// ---- The check --------------------------------------------------------------------

/** The parts of an edition (or of a save request) that the check reads. */
export interface DoNotFeatureCheckable {
  featured: { founder: string; company?: string; topic: string }[];
  bodyHtml: string;
  // What subscribers see before they open the email, plus the campaign's name in Mailchimp.
  // Optional so a caller that has none of them (or has not got to them yet) can leave them out.
  subject?: string;
  previewText?: string;
  label?: string;
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

// A "<" only starts a tag when a letter, "/" or "!" comes next, so "We <3 you" and "< $5" stay
// plain text and cannot swallow the words after them. A tag cannot contain another "<" either,
// so each "<" is looked at once and the search stays linear (a body of 200 000 "<" is instant).
const TAG = /<\/?[A-Za-z!][^<>]*>/g;

// The words a reader could see in the email. Tags are removed first, so a name sitting
// inside <b>...</b> is still found, and tag or attribute text such as a colour never counts.
// Image alt text and title text are kept because they are read aloud or shown on hover.
// It returns two versions of the text on purpose: one where each tag becomes a space, and
// one where each tag becomes nothing (which catches a name cut in two by a tag, like
// Tide<b>water</b>). Checking both means a rare false alarm, and never a missed name.
// HTML entities (&#97; &shy; &eacute; ...) are left in: findNameMentions decodes them.
function visibleTexts(html: string): string[] {
  const alt = [...html.matchAll(/\b(?:alt|title)\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2]).join(' ');
  return [html.replace(TAG, ' ') + ' ' + alt, html.replace(TAG, '') + ' ' + alt];
}

/**
 * Plain-language problems if the edition names anyone on the list: in a featured story's
 * founder, company or topic, in the subject line, preview text or label, or anywhere in the
 * visible text of the body. Empty means clean.
 */
export function doNotFeatureProblems(edition: DoNotFeatureCheckable, list: ListedName[]): string[] {
  const problems: string[] = [];
  const names = list.map((e) => e.name);
  // Each text is read once against ALL the names (reading a 200 000-character body once per name would be slow).
  // Every text is checked on its own, so a name cannot be "found" by gluing two fields together.
  const namedIn = (texts: (string | undefined)[]) => new Set(texts.flatMap((text) => findNameMentions(text ?? '', names)));

  const stories = (edition.featured ?? []).map((f) => ({ f, hits: namedIn([f.founder, f.company, f.topic]) }));
  const others = [
    { what: 'subject line', hits: namedIn([edition.subject]) },
    { what: 'preview text', hits: namedIn([edition.previewText]) },
    { what: 'edition label', hits: namedIn([edition.label]) },
  ];
  const body = namedIn(visibleTexts(edition.bodyHtml ?? ''));

  for (const entry of list) {
    for (const { f, hits } of stories) {
      if (!hits.has(entry.name)) continue;
      const who = f.company ? `${f.founder}, ${f.company}` : f.founder;
      problems.push(`${why(entry)} The featured story "${f.topic}" (${who}) names them.`);
    }
    for (const { what, hits } of others) {
      if (hits.has(entry.name)) problems.push(`${why(entry)} The ${what} names them.`);
    }
    if (body.has(entry.name)) problems.push(`${why(entry)} The newsletter body names them.`);
  }
  return problems;
}
