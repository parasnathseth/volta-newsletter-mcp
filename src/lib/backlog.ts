import { newEditionId } from './edition.ts';

// The founder backlog is Bader's private working list of people worth writing about
// later ("revisit in the spring, just raised a seed round"). It deliberately has NO
// consent field: consent is per story and lives on each featured item of an edition.
//
// Storage: the whole backlog is ONE KV document read and written by exact key. KV
// `list` (and the metadata it returns) is eventually consistent, so an earlier
// per-entry-key design missed duplicates and due dates right after a write. A single
// document is read-your-writes. The backlog is small (dozens of people), so this is
// cheap; two people editing in the same instant could overwrite each other, which is
// acceptable for one or two editors.
//
// Highlights: any signed-in person can add entries, and submittedBy records who did. An entry
// added by someone other than the editor is reference material for the editor. It is still
// only a note: it never carries consent and never goes into a newsletter by itself.
// Anything the editor picks has to become an item and pass vet_updates first.

export type BacklogStatus = 'idea' | 'featured' | 'passed';

export interface BacklogEntry {
  id: string;
  founder: string;
  company: string;
  note: string;
  links: string[];
  revisitDate: string | null; // YYYY-MM-DD
  status: BacklogStatus;
  featuredInEditions: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  submittedBy: string; // email of the signed-in user who added it (set by the server); never changes afterwards
}

export interface BacklogEnv {
  OAUTH_KV: KVNamespace;
}

export class BacklogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacklogError';
  }
}

const DOC_KEY = 'backlog:all';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const dupKey = (founder: string, company: string) => `${norm(founder)}|${norm(company)}`;

function validDate(d: string): boolean {
  return DATE_ONLY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
}

function cleanLinks(links: string[]): string[] {
  if (links.length > 10) throw new BacklogError('At most 10 links per entry.');
  return [...new Set(links.map((l) => l.trim()).filter(Boolean))].map((l) => {
    if (l.length > 500 || !/^https?:\/\/\S+$/i.test(l)) throw new BacklogError(`"${l.slice(0, 60)}" is not a valid http(s) link.`);
    return l;
  });
}

function checkFields(f: { founder?: string; company?: string; note?: string; revisitDate?: string | null }) {
  if (f.founder !== undefined && (!f.founder.trim() || f.founder.length > 100)) throw new BacklogError('A founder name (up to 100 characters) is required.');
  if (f.company !== undefined && f.company.length > 100) throw new BacklogError('The company name is too long (max 100 characters).');
  if (f.note !== undefined && f.note.length > 2000) throw new BacklogError('The note is too long (max 2000 characters).');
  if (f.revisitDate && !validDate(f.revisitDate)) throw new BacklogError('revisitDate must be a real date like 2027-01-15.');
}

// Entries saved earlier may lack submittedBy (fall back to updatedBy) and may still carry an
// old "origin" field. That field is dropped on load, so it is never written back.
type StoredEntry = Omit<BacklogEntry, 'submittedBy'> & { submittedBy?: string; origin?: unknown };

async function loadAll(env: BacklogEnv): Promise<BacklogEntry[]> {
  const doc = (await env.OAUTH_KV.get(DOC_KEY, 'json')) as { entries: StoredEntry[] } | null;
  return (doc?.entries ?? []).map(({ origin, ...e }) => ({ ...e, submittedBy: e.submittedBy ?? e.updatedBy }));
}

const saveAll = (env: BacklogEnv, entries: BacklogEntry[]) => env.OAUTH_KV.put(DOC_KEY, JSON.stringify({ entries }));

const findIn = (entries: BacklogEntry[], id: string): BacklogEntry => {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new BacklogError(`No backlog entry with id "${id}". Use backlog_list to find the right one.`);
  return e;
};

export async function addEntry(
  env: BacklogEnv,
  input: { founder: string; company?: string; note?: string; links?: string[]; revisitDate?: string | null },
  by: string,
): Promise<BacklogEntry> {
  checkFields(input);
  if (!input.founder?.trim()) throw new BacklogError('A founder name is required.');
  const company = input.company?.trim() ?? '';

  const entries = await loadAll(env);
  const dup = entries.find((e) => dupKey(e.founder, e.company) === dupKey(input.founder, company));
  if (dup) {
    const name = `"${input.founder.trim()}${company ? ` (${company})` : ''}"`;
    throw new BacklogError(`${name} is already in the backlog (id ${dup.id}, status ${dup.status}). Use backlog_update to change it instead of adding a duplicate.`);
  }

  const now = new Date().toISOString();
  const entry: BacklogEntry = {
    id: newEditionId(),
    founder: input.founder.trim(),
    company,
    note: input.note?.trim() ?? '',
    links: cleanLinks(input.links ?? []),
    revisitDate: input.revisitDate || null,
    status: 'idea',
    featuredInEditions: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
    submittedBy: by,
  };
  await saveAll(env, [...entries, entry]);
  return entry;
}

export async function listEntries(
  env: BacklogEnv,
  opts: { status?: BacklogStatus | 'all'; dueBy?: string; query?: string; limit?: number },
): Promise<{ total: number; entries: BacklogEntry[] }> {
  if (opts.dueBy && !validDate(opts.dueBy)) throw new BacklogError('dueBy must be a real date like 2027-01-15.');
  const status = opts.status ?? 'idea';
  const q = opts.query ? norm(opts.query) : '';

  const entries = (await loadAll(env)).filter((e) => {
    if (status !== 'all' && e.status !== status) return false;
    if (opts.dueBy && !(e.revisitDate && e.revisitDate <= opts.dueBy)) return false;
    if (q && !norm([e.founder, e.company, e.note, ...e.links].join(' ')).includes(q)) return false;
    return true;
  });

  // Entries with a revisit date first (soonest first), then the rest, newest first.
  entries.sort((a, b) => {
    if (a.revisitDate && b.revisitDate) return a.revisitDate < b.revisitDate ? -1 : a.revisitDate > b.revisitDate ? 1 : 0;
    if (a.revisitDate) return -1;
    if (b.revisitDate) return 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return { total: entries.length, entries: entries.slice(0, Math.min(opts.limit ?? 50, 200)) };
}

export interface BacklogUpdate {
  id: string;
  founder?: string;
  company?: string;
  note?: string; // replaces the note
  appendNote?: string; // adds a dated line to the note
  links?: string[]; // replaces the links
  revisitDate?: string | null; // null clears it
  status?: BacklogStatus;
  featuredInEditionId?: string; // records that the person was featured in this edition
}

export async function updateEntry(env: BacklogEnv, u: BacklogUpdate, by: string): Promise<BacklogEntry> {
  checkFields(u);
  const entries = await loadAll(env);
  const e = findIn(entries, u.id);
  const now = new Date().toISOString();

  const founder = u.founder?.trim() ?? e.founder;
  const company = u.company === undefined ? e.company : u.company.trim();
  if (dupKey(founder, company) !== dupKey(e.founder, e.company)) {
    const dup = entries.find((x) => x.id !== e.id && dupKey(x.founder, x.company) === dupKey(founder, company));
    if (dup) throw new BacklogError(`Another entry for "${founder}${company ? ` (${company})` : ''}" already exists (id ${dup.id}).`);
  }

  let note = u.note === undefined ? e.note : u.note.trim();
  if (u.appendNote?.trim()) note = `${note ? `${note}\n` : ''}${now.slice(0, 10)}: ${u.appendNote.trim()}`;
  if (note.length > 2000) throw new BacklogError('The note would be too long (max 2000 characters).');

  const featuredIn = u.featuredInEditionId && !e.featuredInEditions.includes(u.featuredInEditionId) ? [...e.featuredInEditions, u.featuredInEditionId] : e.featuredInEditions;
  const updated: BacklogEntry = {
    ...e,
    founder,
    company,
    note,
    links: u.links ? cleanLinks(u.links) : e.links,
    revisitDate: u.revisitDate === undefined ? e.revisitDate : u.revisitDate || null,
    status: u.status ?? (u.featuredInEditionId ? 'featured' : e.status),
    featuredInEditions: featuredIn,
    updatedAt: now,
    updatedBy: by,
  };
  await saveAll(env, entries.map((x) => (x.id === e.id ? updated : x)));
  return updated;
}

/** Permanently deletes an entry and returns what was removed. Leaves editions untouched. */
export async function removeEntry(env: BacklogEnv, id: string, by: string): Promise<BacklogEntry> {
  const entries = await loadAll(env);
  const e = findIn(entries, id);
  await saveAll(env, entries.filter((x) => x.id !== id));
  return e;
}
