import { newEditionId } from './edition.ts';
import { scanForInjection } from './injection.ts';

// Each newsletter carries ONE specific startup idea plus the AI Residency call to action.
// The server cannot judge whether an idea is GOOD. What it can do is refuse ideas that are
// unstructured, unsupported (a number with no source) or a repeat of an earlier issue.
// `checkIdea` is the pure rule check (no storage, no network). `recordIdea` stores an
// approved idea so the next issue can avoid repeating it.
//
// Storage: the idea log is ONE KV document read and written by exact key, never by KV
// `list` (see backlog.ts for why). Two editors recording in the same instant could
// overwrite each other; that is acceptable for one or two editors.

export interface IdeaEvidence {
  url: string;
  quote: string; // a short quote from that page showing the problem or the timing
  note?: string;
}

export interface IdeaExisting {
  name: string; // a product or competitor that already exists
  url: string;
  difference: string; // how this idea differs from it
}

export interface IdeaInput {
  title: string;
  pitch: string; // one line
  who: string; // a specific type of customer in Atlantic Canada
  whyNow: string; // one sentence
  tryThisWeek: string; // one cheap first test
  residencyLine: string; // the AI Residency call to action, copied from the live /ai-residency page
  evidence: IdeaEvidence[]; // at least 2
  existing: IdeaExisting[]; // at least 1
  // What the agent says it did. The server cannot verify this; it only notices when it is missing.
  agentChecks?: { opened: string[]; found?: string };
}

export interface IdeaCheck {
  ok: boolean;
  /** Reasons the idea cannot be recorded, in plain language for the editor. */
  problems: string[];
  /** Advice that does not block recording. */
  warnings: string[];
  /** Words in pitch + who + why now + try this week (the residency line is not counted). */
  wordCount: number;
}

export interface IdeaEntry {
  id: string;
  recordedAt: string;
  recordedBy: string;
  editionId?: string;
  idea: IdeaInput;
}

/** The only parts of a past idea that the repeat check needs. */
export interface PastIdea {
  recordedAt?: string;
  idea: { title: string; pitch: string };
}

export interface IdeaEnv {
  OAUTH_KV: KVNamespace;
}

export class IdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaError';
  }
}

const DOC_KEY = 'ideas:log';

// Same shape as an edition id (see EDITION_ID in edition.ts). Checked before an id is stored.
const EDITION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------- Limits and word lists (all in one place so they are easy to read and change) ----------

export const MAX_WORDS = 120; // pitch + who + why now + try this week, together
const MIN_EVIDENCE = 2;
const MAX_EVIDENCE = 6;
const MIN_EXISTING = 1;
const MAX_EXISTING = 6;
const SHORT_QUOTE_CHARS = 20; // a quote shorter than this earns a warning
const MIN_WHO_WORDS = 3;
const REPEAT_OVERLAP = 0.6; // pitch word overlap at or above this counts as a repeat
const SHORT_WORD_LENGTH = 3; // words this short (or shorter) are ignored in the overlap ("the", "for", "and")

// The outer limits on what one idea may carry, whatever the fields are. They are checked FIRST, and an
// idea over them is refused before anything else reads it, so a huge input cannot make the slower checks
// (injection scan, number search) work for long. The tool layer applies the same numbers.
export const HARD_LIMITS = { text: 1000, items: 10, opened: 10, openedLength: 500 };

// The longest each piece of text may be. These stop a single field from swelling the stored log.
const MAX_LENGTH = { title: 100, pitch: 200, who: 200, whyNow: 300, tryThisWeek: 300, residencyLine: 400, quote: 400, note: 300, name: 100, difference: 300, url: 500, found: 1000 };

// Vague marketing phrases. They tell a reader nothing about who has the problem. Checked in
// the pitch and in "who". Hyphens and spacing are ignored, so "AI-powered platform" and
// "ai powered   platform" both match.
export const BANNED_PHRASES = ['uber for', 'airbnb for', 'netflix for', 'ai-powered platform', 'revolutionize', 'disrupt', 'game-changing', 'for everyone', 'for businesses', 'leverage ai'];

// "who" must name a specific type of customer. On its own, any of these is too generic.
export const GENERIC_WHO = ['businesses', 'everyone', 'companies', 'people', 'users', 'customers'];

// ---------- Small helpers ----------

/** Lower-case words made of letters and digits only ("AI-powered!" gives "ai", "powered"). */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Turns a link into a comparison key: same page written two ways ("www.", trailing slash) gives the same key. Null if it is not an http(s) link. */
function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
}

const validUrl = (raw: string) => raw.length <= MAX_LENGTH.url && /^https?:\/\/\S+$/i.test(raw) && urlKey(raw) !== null;

/** Digit sequences in a text, with thousands commas removed: "1,200" and "1200" both give "1200". A trailing % or x is not part of the match, so it is ignored automatically. */
function numbersIn(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map((n) => n.replace(/,/g, ''));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

/** Problems with size alone (see HARD_LIMITS). Works on the raw input, so it must not assume any field is present or the right type. */
function oversizeProblems(input: IdeaInput): string[] {
  const evidence = listOf<Partial<IdeaEvidence>>(input?.evidence);
  const existing = listOf<Partial<IdeaExisting>>(input?.existing);
  const opened = listOf<unknown>(input?.agentChecks?.opened);
  const problems: string[] = [];
  if (evidence.length > HARD_LIMITS.items) problems.push(`Send at most ${HARD_LIMITS.items} evidence links (found ${evidence.length}).`);
  if (existing.length > HARD_LIMITS.items) problems.push(`Send at most ${HARD_LIMITS.items} existing products (found ${existing.length}).`);
  if (opened.length > HARD_LIMITS.opened) problems.push(`List at most ${HARD_LIMITS.opened} opened links in agentChecks (found ${opened.length}).`);
  if (problems.length) return problems; // do not look inside lists that are already too long

  const tooLong = (value: unknown, max: number) => typeof value === 'string' && value.length > max;
  const texts = [
    input?.title, input?.pitch, input?.who, input?.whyNow, input?.tryThisWeek, input?.residencyLine, input?.agentChecks?.found,
    ...evidence.flatMap((e) => [e?.url, e?.quote, e?.note]),
    ...existing.flatMap((e) => [e?.name, e?.url, e?.difference]),
  ];
  if (texts.some((t) => tooLong(t, HARD_LIMITS.text))) problems.push(`No text may be longer than ${HARD_LIMITS.text} characters. Shorten the longest one.`);
  if (opened.some((o) => tooLong(o, HARD_LIMITS.openedLength))) problems.push(`Each opened link in agentChecks may be at most ${HARD_LIMITS.openedLength} characters.`);
  return problems;
}

/**
 * Trims everything and fills in anything missing, so the checks below never crash on a
 * half-empty idea. The checks then report the missing pieces in plain language.
 */
function tidy(input: IdeaInput): IdeaInput {
  const evidence = (Array.isArray(input?.evidence) ? input.evidence : []).map((e) => {
    const item: IdeaEvidence = { url: str(e?.url), quote: str(e?.quote) };
    if (str(e?.note)) item.note = str(e.note);
    return item;
  });
  const existing = (Array.isArray(input?.existing) ? input.existing : []).map((e) => ({ name: str(e?.name), url: str(e?.url), difference: str(e?.difference) }));

  const idea: IdeaInput = {
    title: str(input?.title),
    pitch: str(input?.pitch),
    who: str(input?.who),
    whyNow: str(input?.whyNow),
    tryThisWeek: str(input?.tryThisWeek),
    residencyLine: str(input?.residencyLine),
    evidence,
    existing,
  };
  if (input?.agentChecks) {
    const opened = (Array.isArray(input.agentChecks.opened) ? input.agentChecks.opened : []).map(str).filter(Boolean);
    idea.agentChecks = { opened };
    if (str(input.agentChecks.found)) idea.agentChecks.found = str(input.agentChecks.found);
  }
  return idea;
}

/** Every piece of text in the idea, with a plain label and its length limit. Used for the length limits and the injection scan. */
function allTexts(idea: IdeaInput): Array<{ label: string; text: string; max: number }> {
  const list = [
    { label: 'The title', text: idea.title, max: MAX_LENGTH.title },
    { label: 'The pitch', text: idea.pitch, max: MAX_LENGTH.pitch },
    { label: '"Who needs it"', text: idea.who, max: MAX_LENGTH.who },
    { label: '"Why now"', text: idea.whyNow, max: MAX_LENGTH.whyNow },
    { label: '"Try this week"', text: idea.tryThisWeek, max: MAX_LENGTH.tryThisWeek },
    { label: 'The AI Residency line', text: idea.residencyLine, max: MAX_LENGTH.residencyLine },
  ];
  idea.evidence.forEach((e, i) => {
    list.push({ label: `The quote for evidence link ${i + 1}`, text: e.quote, max: MAX_LENGTH.quote });
    list.push({ label: `The note for evidence link ${i + 1}`, text: e.note ?? '', max: MAX_LENGTH.note });
  });
  idea.existing.forEach((e, i) => {
    list.push({ label: `The name of existing product ${i + 1}`, text: e.name, max: MAX_LENGTH.name });
    list.push({ label: `The difference for existing product ${i + 1}`, text: e.difference, max: MAX_LENGTH.difference });
  });
  list.push({ label: 'The agent\'s note about other products it found', text: idea.agentChecks?.found ?? '', max: MAX_LENGTH.found });
  return list;
}

// ---------- The checks. Each one adds to `problems` (blocks) or `warnings` (advice) ----------

function checkRequiredFields(idea: IdeaInput, problems: string[]): void {
  const required: Array<[string, string]> = [
    [idea.title, 'a title'],
    [idea.pitch, 'the one-line pitch'],
    [idea.who, '"who needs it" (a specific type of customer in Atlantic Canada)'],
    [idea.whyNow, '"why now" (one sentence)'],
    [idea.tryThisWeek, '"try this week" (one cheap first test)'],
    [idea.residencyLine, 'the AI Residency line (copied from the live /ai-residency page)'],
  ];
  for (const [text, label] of required) {
    if (!text) problems.push(`Missing ${label}.`);
  }
  if (idea.pitch.includes('\n')) problems.push('The pitch must be one line, with no line breaks.');
}

function checkEvidence(idea: IdeaInput, problems: string[], warnings: string[]): void {
  if (idea.evidence.length < MIN_EVIDENCE) {
    problems.push(`The idea needs at least ${MIN_EVIDENCE} evidence links, each with a short quote (found ${idea.evidence.length}).`);
  }
  if (idea.evidence.length > MAX_EVIDENCE) problems.push(`Use at most ${MAX_EVIDENCE} evidence links (found ${idea.evidence.length}).`);

  const firstSeen = new Map<string, number>(); // link key -> position of the first link that used it
  idea.evidence.forEach((e, i) => {
    const n = i + 1;
    if (!validUrl(e.url)) {
      problems.push(`Evidence link ${n} is not a valid http(s) link.`);
    } else {
      const key = urlKey(e.url) as string;
      const earlier = firstSeen.get(key);
      if (earlier !== undefined) problems.push(`Evidence link ${n} is the same page as evidence link ${earlier}. Each link must be a different page.`);
      else firstSeen.set(key, n);
    }
    if (!e.quote) problems.push(`Evidence link ${n} has no quote. Copy a short quote from the page that shows the problem or the timing.`);
    else if (e.quote.length < SHORT_QUOTE_CHARS) warnings.push(`The quote for evidence link ${n} is very short (under ${SHORT_QUOTE_CHARS} characters). A fuller quote is easier to check.`);
  });
}

function checkExisting(idea: IdeaInput, problems: string[]): void {
  if (idea.existing.length < MIN_EXISTING) {
    problems.push('Name at least one product or competitor that already exists, with a link and how this idea differs. This is how we check the idea is not already built.');
  }
  if (idea.existing.length > MAX_EXISTING) problems.push(`List at most ${MAX_EXISTING} existing products (found ${idea.existing.length}).`);

  idea.existing.forEach((e, i) => {
    const n = i + 1;
    if (!e.name) problems.push(`Existing product ${n} has no name.`);
    if (!validUrl(e.url)) problems.push(`Existing product ${n} needs a valid http(s) link.`);
    if (!e.difference) problems.push(`Existing product ${n} needs a sentence on how this idea differs from it.`);
  });
}

/** Counts the words the reader will see (pitch, who, why now, try this week) and blocks anything over the cap. Returns the count. */
function checkLength(idea: IdeaInput, problems: string[]): number {
  const wordCount = [idea.pitch, idea.who, idea.whyNow, idea.tryThisWeek].reduce((sum, t) => sum + countWords(t), 0);
  if (wordCount > MAX_WORDS) {
    problems.push(`The idea text is ${wordCount} words (pitch, who, why now and try this week together). The limit is ${MAX_WORDS}. Shorten it.`);
  }
  for (const { label, text, max } of allTexts(idea)) {
    if (text.length > max) problems.push(`${label} is too long (${text.length} characters, the limit is ${max}).`);
  }
  return wordCount;
}

/** Blocks invented statistics: every number in the idea text must also be written in at least one evidence quote. */
function checkNumbers(idea: IdeaInput, problems: string[]): void {
  const quoted = new Set(idea.evidence.flatMap((e) => numbersIn(e.quote)));
  const fields: Array<[string, string]> = [
    ['title', idea.title],
    ['pitch', idea.pitch],
    ['"who needs it"', idea.who],
    ['"why now"', idea.whyNow],
    ['"try this week"', idea.tryThisWeek],
  ];
  for (const [label, text] of fields) {
    for (const n of new Set(numbersIn(text))) {
      if (!quoted.has(n)) {
        problems.push(`The number ${n} in the ${label} does not appear in any evidence quote. Use only numbers that are written in a quote from an evidence link, or take it out. (If it is part of a word such as "B2B", write the word out.)`);
      }
    }
  }
}

function checkVagueWording(idea: IdeaInput, problems: string[]): void {
  const fields: Array<[string, string]> = [
    ['pitch', idea.pitch],
    ['"who needs it"', idea.who],
  ];
  for (const [label, text] of fields) {
    // A space is put in front of both sides so a phrase only matches at the start of a word
    // ("uber for" must not match inside "hubert for"). The end is left open on purpose, so
    // "disrupt" also catches "disrupting" and "disruption".
    const plain = ` ${words(text).join(' ')}`;
    for (const phrase of BANNED_PHRASES) {
      if (plain.includes(` ${words(phrase).join(' ')}`)) {
        problems.push(`The ${label} uses vague wording ("${phrase}"). Say concretely who has the problem and what changes for them.`);
      }
    }
  }
}

function checkWho(idea: IdeaInput, problems: string[]): void {
  if (!idea.who) return; // already reported as missing
  const plain = words(idea.who).join(' ');
  if (GENERIC_WHO.includes(plain)) {
    problems.push(`"Who needs it" says only "${idea.who}". Name a specific type of customer in Atlantic Canada, for example "independent seafood processors in Nova Scotia".`);
  } else if (words(idea.who).length < MIN_WHO_WORDS) {
    problems.push(`"Who needs it" is too short to be specific (use at least ${MIN_WHO_WORDS} words). Name a specific type of customer in Atlantic Canada, for example "independent seafood processors in Nova Scotia".`);
  }
}

/** Text read from web pages can carry instructions aimed at an AI. Any finding blocks the idea. */
function checkInjection(idea: IdeaInput, problems: string[]): void {
  for (const { label, text } of allTexts(idea)) {
    if (!text) continue;
    const { findings } = scanForInjection(text);
    if (findings.length > 0) {
      problems.push(`${label} contains text aimed at an AI or hidden characters (${findings.join(' ')}). Rewrite it in your own words.`);
    }
  }
}

/** How much two pitches share: shared words divided by all different words used, ignoring very short words. 0 is nothing in common, 1 is identical. */
function pitchOverlap(a: string, b: string): number {
  const x = new Set(words(a).filter((w) => w.length > SHORT_WORD_LENGTH));
  const y = new Set(words(b).filter((w) => w.length > SHORT_WORD_LENGTH));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

function checkRepeat(idea: IdeaInput, history: PastIdea[], problems: string[]): void {
  const title = words(idea.title).join(' ');
  for (const past of history) {
    const when = past.recordedAt ? ` (recorded ${past.recordedAt.slice(0, 10)})` : '';
    const earlier = `"${past.idea.title}"${when}`;
    if (title && title === words(past.idea.title).join(' ')) {
      problems.push(`This idea has the same title as an earlier idea, ${earlier}. Choose a different idea.`);
      return; // one earlier idea is enough to explain the problem
    }
    const overlap = pitchOverlap(idea.pitch, past.idea.pitch);
    if (overlap >= REPEAT_OVERLAP) {
      problems.push(`The pitch is ${Math.round(overlap * 100)}% the same wording as an earlier idea, ${earlier}. Choose a different idea.`);
      return;
    }
  }
}

function checkAgentChecks(idea: IdeaInput, warnings: string[]): void {
  const opened = idea.agentChecks?.opened ?? [];
  if (opened.length === 0) {
    warnings.push('There is no record that the evidence links were opened. Open each evidence link, confirm the quote is really on the page, and list the links in agentChecks.opened.');
    return;
  }
  const openedKeys = new Set(opened.map(urlKey));
  idea.evidence.forEach((e, i) => {
    const key = urlKey(e.url);
    if (key !== null && !openedKeys.has(key)) warnings.push(`Evidence link ${i + 1} is not in the list of links that were opened.`);
  });
}

/**
 * The full rule check. Pure: it reads nothing from KV or the network. `history` is the
 * ideas already recorded, used to catch repeats. Problems block recording; warnings do not.
 */
export function checkIdea(input: IdeaInput, history: PastIdea[]): IdeaCheck {
  const tooBig = oversizeProblems(input);
  if (tooBig.length) return { ok: false, problems: tooBig, warnings: [], wordCount: 0 };
  const idea = tidy(input);
  const problems: string[] = [];
  const warnings: string[] = [];

  checkRequiredFields(idea, problems);
  checkEvidence(idea, problems, warnings);
  checkExisting(idea, problems);
  const wordCount = checkLength(idea, problems);
  checkNumbers(idea, problems);
  checkVagueWording(idea, problems);
  checkWho(idea, problems);
  checkInjection(idea, problems);
  checkRepeat(idea, history, problems);
  checkAgentChecks(idea, warnings);

  return { ok: problems.length === 0, problems, warnings, wordCount };
}

// ---------- Storage ----------

async function loadAll(env: IdeaEnv): Promise<IdeaEntry[]> {
  const doc = (await env.OAUTH_KV.get(DOC_KEY, 'json')) as { entries: IdeaEntry[] } | null;
  return doc?.entries ?? [];
}

const saveAll = (env: IdeaEnv, entries: IdeaEntry[]) => env.OAUTH_KV.put(DOC_KEY, JSON.stringify({ entries }));

/** Runs checkIdea against the ideas already recorded. Stores nothing. Used by idea_check. */
export async function checkIdeaAgainstLog(env: IdeaEnv, input: IdeaInput): Promise<IdeaCheck> {
  return checkIdea(input, await loadAll(env));
}

/** Stores an approved idea. The checks run again here against the stored history, so a caller cannot skip them. */
export async function recordIdea(env: IdeaEnv, input: IdeaInput, by: string, editionId?: string): Promise<IdeaEntry> {
  if (editionId && !EDITION_ID.test(editionId)) throw new IdeaError('That does not look like an edition id.');

  const entries = await loadAll(env);
  const result = checkIdea(input, entries);
  if (!result.ok) throw new IdeaError(`This idea cannot be recorded yet:\n- ${result.problems.join('\n- ')}`);

  const entry: IdeaEntry = {
    id: newEditionId(),
    recordedAt: new Date().toISOString(),
    recordedBy: by,
    ...(editionId ? { editionId } : {}),
    idea: tidy(input), // store the trimmed version that was checked
  };
  await saveAll(env, [...entries, entry]);
  return entry;
}

/** Recorded ideas, newest first. `total` counts everything recorded, before the limit. */
export async function listIdeas(env: IdeaEnv, limit = 20): Promise<{ total: number; entries: IdeaEntry[] }> {
  const entries = await loadAll(env);
  const newestFirst = [...entries].reverse(); // the log is appended to, so the last one is the newest
  return { total: entries.length, entries: newestFirst.slice(0, Math.min(Math.max(limit, 1), 100)) };
}
