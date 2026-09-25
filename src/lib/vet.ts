// Vetting: decides, for every update collected for the newsletter, whether it is safe and
// sensible to FEATURE, must be HELD for Bader, or should be DROPPED.
//
// This is the server half of a two-layer check. The rules below are plain and deterministic:
// they cannot be talked out of a decision by anything written inside an update. The other
// half is Claude double-checking the things a server cannot see (opening the linked pages,
// spotting the same story worded differently). Claude reports that as `agentChecks`, and
// the final verdict is the STRICTER of the two (see mergeAgent).
//
// This file is PURE: no storage, no network, no AI, and no clock. Today's date is never
// read; the newsletter date is an input, so the same input always gives the same answer.
//
// ORDER OF THE RULES (fixed, and the order matters)
//   0. injection    - clean every item's text first, so no rule below reads an instruction
//                     aimed at an AI. Findings become flags. Cleaning itself never decides a
//                     verdict; the `injection` rule (last in the list, a HOLD) does: an item that
//                     carried an instruction for an AI is not featured until Bader has looked.
//   1. do_not_feature   drop   the item is about someone on the do-not-feature list
//                       hold   a founder or ask item whose TITLE names someone on the list
//   2. past             drop   an event whose date is before the newsletter date
//   3. old_news         drop   a non-event dated before the last issue
//   4. repeat           drop   the same link AND the same company or title was in the last issue
//   5. duplicate        drop   same link and same subject as an EARLIER item
//   6. no_link/hearsay  drop   no usable http(s) link. Exception: a founder story marked
//                              sourceKind "founder_provided" (first told to the editor, so nothing
//                              public to link) may have none if it has a sourceNote; with no note
//                              it is dropped as hearsay only while consent is not yes.
//   6b. source_note     hold   a founder_provided story with consent yes but no link and no sourceNote
//   7. bad_date         hold   a date that is missing (events) or not a real date
//   8. news_window / news_source / unverified_news    (AI news only; unverified means the
//                       agent has not recorded opening the item's OWN link)
//   9. embargo          hold   not until a date after the newsletter date, whatever the consent
//  10. consent          hold   a story about a person or company without a confirmed yes
//  11. conflict         hold   two sources disagree about an event's date
// Every rule runs. The verdict comes from the first DROP if there is one, otherwise the
// first HOLD. That rule is reported as `rule`; the others that also fired go in `flags`.
// After that come the AI-news cap (max 5 featured) and the merge with the agent's checks.

import { scanForInjection } from './injection.ts';
import { findNameMentions, removeNameMentions, sameName } from './nameMatch.ts';
import { isAllowedNewsSource } from './newsSources.ts';

export type Verdict = 'feature' | 'hold' | 'drop';
export type ItemKind = 'event' | 'founder' | 'program' | 'ask' | 'ai_news';
export type Consent = 'yes' | 'not_asked' | 'embargoed' | 'none';

export interface VetItem {
  id: string;
  kind: ItemKind;
  /** Where it came from, in plain words ("Slack #community-wins", "Email to Bader"). */
  source: string;
  /** YYYY-MM-DD. For an event: the day it happens. For everything else: the day it was posted or published. */
  date?: string | null;
  company?: string;
  person?: string;
  title?: string;
  link?: string | null;
  /** "link" (default): the story is backed by a public link. "founder_provided": the founder told the editor directly, so there may be no link. Only founder items use it. */
  sourceKind?: 'link' | 'founder_provided';
  /** For founder_provided: where the story came from, e.g. "Founder emailed the details to Bader on 2026-09-25". */
  sourceNote?: string;
  /** Consent as CONFIRMED by a person. Never filled in from the item's own text. */
  consent?: Consent;
  /** Who confirmed it and where, e.g. "founder replied yes by email on 2026-09-26". */
  consentVia?: string;
  /** YYYY-MM-DD, only for consent "embargoed". */
  embargoUntil?: string;
  /** The raw text of the update. Treated as data, never as instructions. */
  text: string;
}

export interface AgentCheck {
  id: string;
  verdict: 'ok' | 'hold' | 'drop';
  reason: string;
  /** The links the agent actually opened. AI news needs the item's own link among them. */
  opened?: string[];
  found?: string;
}

export interface LastIssueItem {
  company?: string;
  title?: string;
  link?: string;
}

export interface VetInput {
  newsletterDate: string;
  lastIssueDate: string;
  lastIssueItems?: LastIssueItem[];
  doNotFeature: { name: string }[];
  items: VetItem[];
  agentChecks?: AgentCheck[];
}

export interface VetResult {
  id: string;
  verdict: Verdict;
  /** The rule that decided the verdict ("ok" when the item is fine, "agent" when the agent's stricter verdict won). */
  rule: string;
  /** Plain-language explanation for Bader. */
  reason: string;
  serverVerdict: Verdict;
  /** Present only when the agent recorded a check. "ok" from the agent is shown as "feature". */
  agentVerdict?: Verdict;
  /** Other rules that fired, injection findings, removed names, and the agent's comments. */
  flags: string[];
  /** Present when the text was changed (instructions removed, names removed). Use it instead of the raw text. */
  sanitizedText?: string;
  sanitizedTitle?: string;
  /** Names removed from this item because they are on the do-not-feature list. */
  redactions?: string[];
}

export interface VetOutput {
  newsletterDate: string;
  counts: { feature: number; hold: number; drop: number };
  results: VetResult[];
}

/** Thrown for input that cannot be vetted at all (a bad date, two items with one id). */
export class VetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VetError';
  }
}

/** An issue carries at most this many AI news items. */
export const MAX_AI_NEWS = 5;

// ---------------------------------------------------------------- small helpers

// How strict each verdict is: feature is the loosest, drop the strictest.
const STRICTNESS: Record<Verdict, number> = { feature: 0, hold: 1, drop: 2 };

/** True for a real calendar date written YYYY-MM-DD (so "2027-02-30" is not). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
// Valid YYYY-MM-DD dates sort correctly as plain strings, so "<" and ">" compare them.

/**
 * A comparable form of an http(s) link, or null when it is not a usable link. Ignores
 * http vs https, "www.", a trailing slash, a #fragment and tracking tags (utm_*, fbclid, gclid,
 * mc_cid, mc_eid), none of which change which page it is.
 */
const TRACKING_PARAMS = ['fbclid', 'gclid', 'mc_cid', 'mc_eid'];

export function normalizeLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (name.startsWith('utm_') || TRACKING_PARAMS.includes(name)) url.searchParams.delete(key);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '') return null;
  return `${host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

/** Cuts a value that is echoed into a reason to at most 80 characters. */
const short = (value: string) => (value.length > 80 ? `${value.slice(0, 77)}...` : value);

// ---------------------------------------------------------------- one item, prepared

/** What consent counts as once the embargo is taken into account. */
type ConsentState = 'yes' | 'not_yes' | 'embargo_pending';

/** An item with its text cleaned and the facts every rule needs worked out once. */
interface Prepared {
  item: VetItem;
  index: number;
  text: string;
  title: string;
  textEdited: boolean;
  titleEdited: boolean;
  redactions: string[];
  /** The listed names that were in the title (a title names who the item is about). */
  namesInTitle: string[];
  /** Set only if a listed name is still in the text after removal (odd punctuation). */
  leftoverMention: string | null;
  /** The do-not-feature name this item is ABOUT (its company or person), if any. */
  listedName: string | null;
  link: string | null;
  /** The source note after the injection scan ("" when there is none). */
  sourceNote: string;
  /** A founder item marked founder_provided (told to the editor directly). */
  founderProvided: boolean;
  /** The date if it is a real YYYY-MM-DD date, else null. */
  date: string | null;
  /** A date was given but it is not a real date. */
  badDate: boolean;
  consent: ConsentState;
  /** Injection findings, added to the result's flags. */
  flags: string[];
  /** True when text aimed at an AI was found (stray zero-width characters alone do not count). */
  injected: boolean;
}

function consentState(item: VetItem, newsletterDate: string): ConsentState {
  // Rule 2: an embargo date after the newsletter date holds the item, whatever the consent says.
  if (isIsoDate(item.embargoUntil) && item.embargoUntil > newsletterDate) return 'embargo_pending';
  if (item.consent === 'yes') return 'yes';
  if (item.consent === 'embargoed') {
    // Once the embargo date has come, the founder's earlier yes counts. No valid date: still held.
    return isIsoDate(item.embargoUntil) ? 'yes' : 'embargo_pending';
  }
  return 'not_yes';
}

/** The first do-not-feature name found in the item's company or person field. */
function findListedName(item: VetItem, names: string[]): string | null {
  for (const field of [item.company, item.person]) {
    if (!field) continue;
    // "Tidewater Maps Ltd" is still Tidewater Maps, so a name inside the field counts.
    const hit = findNameMentions(field, names)[0];
    if (hit) return hit;
  }
  return null;
}

function prepare(item: VetItem, index: number, names: string[], newsletterDate: string): Prepared {
  const flags: string[] = [];

  // Rule 0 (injection): clean the text and the title before anything else looks at them.
  const textScan = scanForInjection(item.text ?? '');
  const titleScan = scanForInjection(item.title ?? '');
  for (const finding of textScan.findings) flags.push(`injection: ${finding}`);
  for (const finding of titleScan.findings) flags.push(`injection (title): ${finding}`);
  const noteScan = scanForInjection(item.sourceNote ?? '');
  for (const finding of noteScan.findings) flags.push(`injection (source note): ${finding}`);
  let text = textScan.clean;
  let title = titleScan.clean;
  // Hidden characters can come from an ordinary copy and paste, so only real instructions count.
  const injected = [...textScan.findings, ...titleScan.findings, ...noteScan.findings].some((finding) => !/zero-width/i.test(finding));

  // Rule 3 (second half): a listed name mentioned inside another item's words is removed,
  // and the item itself stays.
  const inText = findNameMentions(text, names);
  const inTitle = findNameMentions(title, names);
  const redactions = [...new Set([...inText, ...inTitle])];
  if (inText.length) text = removeNameMentions(text, inText);
  if (inTitle.length) title = removeNameMentions(title, inTitle);
  for (const name of redactions) {
    flags.push(`do_not_feature: Removed the name "${name}" from this item because it is on the do-not-feature list.`);
  }
  const leftoverMention = findNameMentions(`${title}\n${text}`, names)[0] ?? null;

  const givenDate = typeof item.date === 'string' && item.date.trim() !== '' ? item.date.trim() : null;
  return {
    item,
    index,
    text,
    title,
    textEdited: textScan.findings.length > 0 || inText.length > 0,
    titleEdited: titleScan.findings.length > 0 || inTitle.length > 0,
    redactions,
    namesInTitle: inTitle,
    leftoverMention,
    listedName: findListedName(item, names),
    link: normalizeLink(item.link),
    sourceNote: noteScan.clean.trim(),
    founderProvided: item.kind === 'founder' && item.sourceKind === 'founder_provided',
    date: isIsoDate(givenDate) ? givenDate : null,
    badDate: givenDate !== null && !isIsoDate(givenDate),
    consent: consentState(item, newsletterDate),
    flags,
    injected,
  };
}

/** A short name for reasons: company, else person, else title, else the id. */
function label(p: Prepared): string {
  return short(p.item.company || p.item.person || p.title || p.item.id);
}

// ---------------------------------------------------------------- the rules

interface Decision {
  verdict: 'hold' | 'drop';
  rule: string;
  reason: string;
}
const hold = (rule: string, reason: string): Decision => ({ verdict: 'hold', rule, reason });
const drop = (rule: string, reason: string): Decision => ({ verdict: 'drop', rule, reason });

interface LastIssueEntry {
  link: string | null;
  company: string;
  title: string;
}

interface Context {
  newsletterDate: string;
  lastIssueDate: string;
  lastIssue: LastIssueEntry[];
  /** Every prepared item in input order, so a rule can compare an item with the others. */
  all: Prepared[];
  /** Ids the agent recorded opening the item's own link for (used for AI news). */
  verifiedIds: Set<string>;
}

type Rule = (p: Prepared, ctx: Context) => Decision | null;

// Two items are about the same thing when they share a link AND a company or a title.
const sameLink = (a: Prepared, b: Prepared) => a.link !== null && a.link === b.link;
function sameSubject(a: Prepared, b: Prepared): boolean {
  const sameCompany = Boolean(a.item.company && b.item.company && sameName(a.item.company, b.item.company));
  const sameTitle = Boolean(a.title && b.title && sameName(a.title, b.title));
  return sameCompany || sameTitle;
}

// Rule 7 (conflict): two EVENTS with the same link and title but different dates. An event
// has one true date, so two dates means two sources disagree. (Two posts about the same
// news on different days are not a conflict: that is just the same news, a duplicate.)
function conflictsWith(a: Prepared, b: Prepared): boolean {
  if (a.item.kind !== 'event' || b.item.kind !== 'event') return false;
  if (!sameLink(a, b) || !a.title || !b.title || !sameName(a.title, b.title)) return false;
  return a.date !== null && b.date !== null && a.date !== b.date;
}

const ruleDoNotFeature: Rule = (p) => {
  if (!p.listedName) return null;
  return drop('do_not_feature', `${short(p.listedName)} asked not to be featured. That wins over any consent, so this is dropped.`);
};

// A founder or ask item is ABOUT a person or company. If its title names someone on the list,
// taking the name out would leave "a Volta company raises seed", a story about nobody. A person
// has to look at it. (A name only in the body text of a recap is just removed, see prepare.)
const ruleListedNameInTitle: Rule = (p) => {
  if ((p.item.kind !== 'founder' && p.item.kind !== 'ask') || p.namesInTitle.length === 0) return null;
  return hold('do_not_feature', `The title names ${short(p.namesInTitle[0])}, who is on the do-not-feature list, and this item is about a person or company. Removing the name would leave a story about nobody, so Bader must look at it.`);
};

const rulePast: Rule = (p, ctx) => {
  if (p.item.kind !== 'event' || !p.date || p.date >= ctx.newsletterDate) return null;
  return drop('past', `This event was on ${p.date}, before the newsletter date (${ctx.newsletterDate}), so it has already happened.`);
};

// AI news has its own, stricter date rule (news_window), so it is left out here.
const ruleOldNews: Rule = (p, ctx) => {
  const kind = p.item.kind;
  if (kind === 'event' || kind === 'ai_news' || !p.date || p.date >= ctx.lastIssueDate) return null;
  return drop('old_news', `Dated ${p.date}, before the last issue (${ctx.lastIssueDate}), so it is old news.`);
};

// Each text mentions the other (whole words, ignoring case and punctuation).
const mentions = (a: string, b: string) => findNameMentions(a, [b]).length > 0 || findNameMentions(b, [a]).length > 0;

// The same page is not enough (an evergreen page can carry new news): the item's company,
// person or title must also appear in what the last issue said about that link.
function sameAsLastIssue(p: Prepared, entry: LastIssueEntry): boolean {
  if (!entry.company && !entry.title) return true; // nothing but the link to compare
  const mine = [p.item.company ?? '', p.item.person ?? '', p.title];
  return [entry.company, entry.title].some((said) => mine.some((name) => mentions(said, name)));
}

const ruleRepeat: Rule = (p, ctx) => {
  if (!p.link) return null;
  const hit = ctx.lastIssue.find((entry) => entry.link === p.link && sameAsLastIssue(p, entry));
  if (!hit) return null;
  const said = hit.title || hit.company;
  return drop('repeat', `This link and subject were already in the last issue${said ? ` ("${short(said)}")` : ''}. Nothing new is recorded, so it is dropped.`);
};

const ruleDuplicate: Rule = (p, ctx) => {
  // Keep the first one in input order, drop the later copies.
  const first = ctx.all.slice(0, p.index).find((other) => sameLink(other, p) && sameSubject(other, p) && !conflictsWith(other, p));
  if (!first) return null;
  return drop('duplicate', `Same link and same subject as item ${first.item.id}, which came first. This later copy is dropped.`);
};

// Rule 4 (no_link) and the hearsay case. Someone's consent does not make a claim checkable,
// so a missing link drops the item either way; the rule name says which situation it is.
const ruleNoLink: Rule = (p) => {
  if (p.link) return null;
  // A founder_provided story needs no link: with a note it is fine here, and with consent
  // given but no note the source_note rule holds it. Consent not yet given and no note: hearsay.
  if (p.founderProvided && (p.sourceNote || p.consent !== 'not_yes')) return null;
  if (p.consent !== 'yes') {
    return drop('hearsay', 'No link and no confirmed consent. This is something heard, not something readers can check, so it is dropped.');
  }
  return drop('no_link', 'There is no http(s) link to a source, so readers would have nothing to open. It is dropped.');
};

// Consent is there (or an embargo is pending) but nothing says where a link-less story came from.
const ruleSourceNote: Rule = (p) => {
  if (!p.founderProvided || p.link || p.sourceNote || p.consent === 'not_yes') return null;
  return hold('source_note', `${label(p)} has no link and no note on where the story came from. Ask Bader for a short note, for example how and when the founder shared it, or a link.`);
};

const ruleBadDate: Rule = (p) => {
  if (p.badDate) return hold('bad_date', `The date "${short(String(p.item.date))}" is not a real YYYY-MM-DD date, so the date checks could not run. Bader should confirm it.`);
  if (p.item.kind === 'event' && !p.date) return hold('bad_date', 'This event has no date, so nobody can tell whether it is still to come. Bader should confirm it.');
  return null;
};

// Rule 9, AI news. Published after the last issue and on or before the newsletter date.
const ruleNewsWindow: Rule = (p, ctx) => {
  if (p.item.kind !== 'ai_news' || p.badDate) return null;
  if (!p.date) return hold('news_window', 'This news item has no published date, so nobody can tell whether it is new. Bader should confirm it.');
  if (p.date <= ctx.lastIssueDate) return drop('news_window', `Published ${p.date}, which is not after the last issue (${ctx.lastIssueDate}), so it is not new.`);
  if (p.date > ctx.newsletterDate) return drop('news_window', `Dated ${p.date}, which is after the newsletter date (${ctx.newsletterDate}).`);
  return null;
};

// Unknown sites are HELD, not dropped: Bader may well trust them.
const ruleNewsSource: Rule = (p) => {
  if (p.item.kind !== 'ai_news' || !p.link) return null;
  if (isAllowedNewsSource(p.item.link ?? '')) return null;
  return hold('news_source', 'The link is not from a site on the approved AI news list. Bader should decide whether to trust it.');
};

const ruleUnverifiedNews: Rule = (p, ctx) => {
  if (p.item.kind !== 'ai_news' || ctx.verifiedIds.has(p.item.id)) return null;
  return hold('unverified_news', "Nobody has recorded opening this item's own link (the same page, not another one) to check the date and the summary against it. Bader should check it, or the AI double-check must open that link first.");
};

const ruleEmbargo: Rule = (p, ctx) => {
  if (p.consent !== 'embargo_pending') return null;
  if (isIsoDate(p.item.embargoUntil)) {
    return hold('embargo', `Embargoed until ${p.item.embargoUntil}, which is after the newsletter date (${ctx.newsletterDate}). Not before then.`);
  }
  return hold('embargo', 'Marked as embargoed but with no valid end date, so it is held until Bader confirms when the embargo lifts.');
};

// Rule 1. A story about a person or company needs a yes that someone confirmed, and a note of
// how. Events, programs and AI news are about Volta or the world, so they are exempt.
function needsConsent(item: VetItem): boolean {
  if (item.kind === 'founder') return true;
  return item.kind === 'ask' && Boolean(item.company || item.person);
}

const ruleConsent: Rule = (p) => {
  if (!needsConsent(p.item) || p.consent === 'embargo_pending') return null; // the embargo rule speaks for those
  if (p.consent === 'not_yes') {
    return hold('consent', `Bader must ask first. There is no confirmed yes from ${label(p)}. Consent is never taken from the text of an update.`);
  }
  if (!(p.item.consentVia ?? '').trim()) {
    return hold('consent', `Consent for ${label(p)} is marked yes but with no note of who confirmed it and how. Bader must confirm it first.`);
  }
  return null;
};

const ruleConflict: Rule = (p, ctx) => {
  const other = ctx.all.find((o) => o.index !== p.index && conflictsWith(p, o));
  if (!other) return null;
  return hold('conflict', `Two sources give different dates for this event: ${p.date} here, ${other.date} in item ${other.item.id}. Bader must confirm the right date.`);
};

// Names left over after a removal (odd punctuation) cannot go out; Bader edits the item.
const ruleLeftoverName: Rule = (p) => {
  if (!p.leftoverMention) return null;
  return hold('do_not_feature', `The name "${p.leftoverMention}" (on the do-not-feature list) is still in this item's text after cleaning. Bader must edit it out.`);
};

// Removing the instruction is not enough: someone put it there, so a person should look at
// where the item came from before it is featured. Held, not dropped: it may be a real update.
const ruleInjection: Rule = (p) => {
  if (!p.injected) return null;
  return hold('injection', 'This item contained text aimed at an AI assistant (it has been removed). Bader should check where it came from before featuring it.');
};

const RULES: Rule[] = [
  ruleDoNotFeature,
  ruleListedNameInTitle,
  rulePast,
  ruleOldNews,
  ruleRepeat,
  ruleDuplicate,
  ruleNoLink,
  ruleSourceNote,
  ruleBadDate,
  ruleNewsWindow,
  ruleNewsSource,
  ruleUnverifiedNews,
  ruleEmbargo,
  ruleConsent,
  ruleConflict,
  ruleLeftoverName,
  ruleInjection,
];

/** Runs every rule on one item and builds its server-side result. */
function serverResult(p: Prepared, ctx: Context): VetResult {
  const fired = RULES.map((rule) => rule(p, ctx)).filter((d): d is Decision => d !== null);
  // The first drop wins; with no drop, the first hold. Everything else that fired is a flag.
  const decided = fired.find((d) => d.verdict === 'drop') ?? fired[0];
  const flags = [...p.flags];
  for (const d of fired) if (d !== decided) flags.push(`${d.rule}: ${d.reason}`);

  const verdict: Verdict = decided ? decided.verdict : 'feature';
  const result: VetResult = {
    id: p.item.id,
    verdict,
    rule: decided ? decided.rule : 'ok',
    reason: decided ? decided.reason : 'Passed every server check.',
    serverVerdict: verdict,
    flags,
  };
  if (p.textEdited) result.sanitizedText = p.text;
  if (p.titleEdited) result.sanitizedTitle = p.title;
  if (p.redactions.length) result.redactions = p.redactions;
  return result;
}

// ---------------------------------------------------------------- after the rules

/** Rule 9: at most MAX_AI_NEWS news items are featured. Extra ones are held, in input order. */
function capAiNews(results: VetResult[], all: Prepared[]): void {
  let featured = 0;
  results.forEach((result, i) => {
    if (all[i].item.kind !== 'ai_news' || result.verdict !== 'feature') return;
    featured += 1;
    if (featured <= MAX_AI_NEWS) return;
    result.verdict = 'hold';
    result.serverVerdict = 'hold';
    result.rule = 'too_many_news';
    result.reason = `An issue carries at most ${MAX_AI_NEWS} AI news items and ${MAX_AI_NEWS} earlier ones already qualify. Bader can swap this one in for a weaker one.`;
  });
}

function agentVerdictOf(check: AgentCheck): Verdict {
  if (check.verdict === 'ok') return 'feature';
  if (check.verdict === 'hold' || check.verdict === 'drop') return check.verdict;
  throw new VetError(`The AI double-check for item "${check.id}" has verdict "${String(check.verdict)}". It must be ok, hold or drop.`);
}

/** Rule 10: the final verdict is the stricter of server and agent. The agent can never upgrade. */
function mergeAgent(result: VetResult, check: AgentCheck | undefined): void {
  if (!check) return;
  const agent = agentVerdictOf(check);
  result.agentVerdict = agent;
  const said = `The AI double-check said ${check.verdict}: ${check.reason?.trim() || 'no reason given'}${check.found ? ` (found: ${check.found})` : ''}.`;

  if (STRICTNESS[agent] > STRICTNESS[result.serverVerdict]) {
    // The agent is stricter, so its verdict counts. Keep the server's own reason as a flag.
    if (result.serverVerdict !== 'feature') result.flags.push(`${result.rule}: ${result.reason}`);
    result.verdict = agent;
    result.rule = 'agent';
    result.reason = said;
  } else if (agent !== result.serverVerdict) {
    // The agent said ok (or hold where the server said drop). Ignored: it cannot upgrade.
    result.flags.push(`${said} Only the stricter verdict counts, so this stays ${result.verdict}.`);
  } else {
    result.flags.push(said);
  }
}

/** One check per id. If an id appears twice, the stricter check is kept. */
function indexAgentChecks(checks: AgentCheck[]): Map<string, AgentCheck> {
  const byId = new Map<string, AgentCheck>();
  for (const check of checks) {
    const existing = byId.get(check.id);
    if (!existing || STRICTNESS[agentVerdictOf(check)] > STRICTNESS[agentVerdictOf(existing)]) byId.set(check.id, check);
  }
  return byId;
}

/** Ids for which the agent recorded opening the item's OWN link (the same page, not just any link). */
function idsWithOpenedOwnLink(checks: AgentCheck[], all: Prepared[]): Set<string> {
  const ownLink = new Map(all.map((p) => [p.item.id, p.link]));
  const ids = new Set<string>();
  for (const check of checks) {
    const own = ownLink.get(check.id);
    if (own && (check.opened ?? []).some((link) => normalizeLink(link) === own)) ids.add(check.id);
  }
  return ids;
}

function checkInput(input: VetInput): void {
  if (!isIsoDate(input.newsletterDate)) throw new VetError(`newsletterDate must be a real date written YYYY-MM-DD, got "${short(String(input.newsletterDate))}".`);
  if (!isIsoDate(input.lastIssueDate)) throw new VetError(`lastIssueDate must be a real date written YYYY-MM-DD, got "${short(String(input.lastIssueDate))}".`);
  if (input.lastIssueDate > input.newsletterDate) throw new VetError('lastIssueDate cannot be after newsletterDate.');
  if (!Array.isArray(input.items)) throw new VetError('items must be a list.');
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item.id || typeof item.id !== 'string') throw new VetError('Every item needs an id.');
    if (seen.has(item.id)) throw new VetError(`Two items share the id "${item.id}". Every item needs its own id.`);
    seen.add(item.id);
  }
}

// ---------------------------------------------------------------- the entry point

export function vetUpdates(input: VetInput): VetOutput {
  checkInput(input);
  const names = (input.doNotFeature ?? []).map((entry) => entry.name).filter((name) => typeof name === 'string' && name.trim() !== '');
  const agentChecks = indexAgentChecks(input.agentChecks ?? []);

  const all = input.items.map((item, index) => prepare(item, index, names, input.newsletterDate));
  const verifiedIds = idsWithOpenedOwnLink(input.agentChecks ?? [], all);
  const ctx: Context = {
    newsletterDate: input.newsletterDate,
    lastIssueDate: input.lastIssueDate,
    lastIssue: (input.lastIssueItems ?? []).map((entry) => ({ link: normalizeLink(entry.link), company: entry.company ?? '', title: entry.title ?? '' })),
    all,
    verifiedIds,
  };

  const results = all.map((p) => serverResult(p, ctx));
  capAiNews(results, all);
  for (const result of results) mergeAgent(result, agentChecks.get(result.id));

  const counts = { feature: 0, hold: 0, drop: 0 };
  for (const result of results) counts[result.verdict] += 1;
  return { newsletterDate: input.newsletterDate, counts, results };
}
