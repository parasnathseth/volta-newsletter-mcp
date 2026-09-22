import { BRAND_SUMMARY, offBrandProblems } from './brand.ts';
import { unsafeHtmlProblems } from './htmlSafety.ts';

// An "edition" is one newsletter being worked on: its body, subject and the
// founder stories in it (each with its own consent record). Editions live in KV
// so any Claude chat can pick a draft back up. Ids are time-sortable (ULID-style)
// and never tied to a month, so any cadence works.

export type Consent = 'none' | 'requested' | 'confirmed';
export type EditionStatus = 'in_progress' | 'drafted';

export interface Featured {
  id: string;
  founder: string;
  company: string;
  topic: string;
  consent: Consent;
  consentVia: string | null; // how it was given: email, slack, in person, ...
  consentNote: string;
  confirmedAt: string | null;
  outcome: string | null; // filled in later by a founder check-in
}

export interface Edition {
  id: string;
  label: string;
  status: EditionStatus;
  windowStart: string | null;
  windowEnd: string | null;
  subject: string;
  previewText: string;
  bodyHtml: string;
  featured: Featured[];
  campaignId: string | null;
  campaignUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EditionEnv {
  OAUTH_KV: KVNamespace;
}

export interface FeaturedInput {
  id?: string;
  founder: string;
  company?: string;
  topic: string;
  consent?: Consent;
  consentVia?: string | null;
  consentNote?: string;
  outcome?: string | null;
}

export interface EditionInput {
  editionId?: string;
  label?: string;
  status?: EditionStatus;
  windowStart?: string | null;
  windowEnd?: string | null;
  subject?: string;
  previewText?: string;
  bodyHtml?: string;
  /** Set only when the editor explicitly asked for a look outside the brand palette. */
  allowOffBrand?: boolean;
  featured?: FeaturedInput[];
  campaignId?: string | null;
}

export interface EditionSummary {
  id: string;
  label: string;
  status: EditionStatus;
  subject: string;
  updatedAt: string;
  featuredCount: number;
  unconfirmedConsent: number;
}

export class EditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditionError';
  }
}

const KEY_PREFIX = 'edition:';
const POINTER_KEY = 'edition:pointer:latest';
const MAX_BODY_CHARS = 200_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Edition ids are 26 Crockford characters. Checking the shape keeps caller-supplied ids
// from ever addressing other keys in the same KV namespace (for example "index" or "pointer:latest").
const EDITION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Time-sortable id: 10 chars of millisecond timestamp + 16 random chars. */
export function newEditionId(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  return time + [...rnd].map((b) => CROCKFORD[b % 32]).join('');
}

/** Problems that must block creating a Mailchimp draft: every featured story needs confirmed consent. */
export function consentProblems(edition: Pick<Edition, 'featured'>): string[] {
  return edition.featured
    .filter((f) => f.consent !== 'confirmed')
    .map((f) => `Consent for "${f.topic}" (${f.founder}${f.company ? `, ${f.company}` : ''}) is "${f.consent}", not confirmed.`);
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

// Consent is for one specific story: one person and one topic. If either changes for
// an existing story, the earlier consent no longer covers it, so consent resets to
// "none" unless the caller states consent explicitly (for example because the editor
// said it still applies). A story sent without an id is always a NEW story: it never
// reuses an id from the previous list, so it can never inherit someone else's consent.
function normalizeFeatured(input: FeaturedInput[], previous: Featured[], nowIso: string, resets: string[]): Featured[] {
  const usedIds = new Set<string>([...(input.map((f) => f.id?.trim()).filter(Boolean) as string[]), ...previous.map((p) => p.id)]);
  let counter = 0;
  const nextId = () => {
    do counter++;
    while (usedIds.has(`f${counter}`));
    usedIds.add(`f${counter}`);
    return `f${counter}`;
  };

  return input.map((f) => {
    const founder = f.founder?.trim();
    const topic = f.topic?.trim();
    if (!founder) throw new EditionError('Each featured story needs a founder name.');
    if (!topic) throw new EditionError(`The featured story for ${founder} needs a topic.`);

    const id = f.id?.trim() || nextId();
    const prev = previous.find((p) => p.id === id);
    const founderChanged = !!prev && !same(prev.founder, founder);
    const storyChanged = !!prev && (founderChanged || !same(prev.topic, topic));
    const resetByChange = storyChanged && f.consent === undefined && prev!.consent !== 'none';
    if (resetByChange) {
      resets.push(
        `The story changed (was "${prev!.topic}" about ${prev!.founder}, now "${topic}" about ${founder}), so the earlier consent (${prev!.consent}) no longer applies and was reset to "none". Ask the user whether ${founder} agreed to this story.`,
      );
    }
    const consent: Consent = f.consent ?? (storyChanged ? 'none' : prev?.consent ?? 'none');
    const consentVia = f.consentVia === undefined ? (resetByChange ? null : prev?.consentVia ?? null) : f.consentVia?.trim() || null;
    if (consent === 'confirmed' && !consentVia) {
      throw new EditionError(`Consent for "${topic}" (${founder}) is marked confirmed, so say how it was given (email, Slack, in person, ...) in consentVia.`);
    }
    return {
      id,
      founder,
      company: f.company?.trim() ?? (founderChanged ? '' : prev?.company ?? ''),
      topic,
      consent,
      consentVia: consent === 'none' ? null : consentVia,
      consentNote: f.consentNote?.trim() ?? (storyChanged ? '' : prev?.consentNote ?? ''),
      confirmedAt: consent === 'confirmed' ? (prev?.consent === 'confirmed' && prev.confirmedAt && !storyChanged ? prev.confirmedAt : nowIso) : null,
      outcome: f.outcome === undefined ? (storyChanged ? null : prev?.outcome ?? null) : f.outcome,
    };
  });
}

function summarize(e: Edition): EditionSummary {
  return {
    id: e.id,
    label: e.label,
    status: e.status,
    subject: e.subject,
    updatedAt: e.updatedAt,
    featuredCount: e.featured.length,
    unconfirmedConsent: consentProblems(e).length,
  };
}

/** Creates an edition (no editionId) or updates only the fields provided. */
export async function saveEdition(
  env: EditionEnv,
  input: EditionInput,
  by: string,
): Promise<{ edition: Edition; created: boolean; consentWarnings: string[]; draftWarnings: string[]; consentResets: string[] }> {
  const consentResets: string[] = [];
  const now = new Date().toISOString();
  let existing: Edition | null = null;
  if (input.editionId) {
    existing = EDITION_ID.test(input.editionId) ? ((await env.OAUTH_KV.get(`${KEY_PREFIX}${input.editionId}`, 'json')) as Edition | null) : null;
    if (!existing) throw new EditionError(`Edition "${input.editionId}" was not found. Omit editionId to start a new one.`);
  }

  if (input.bodyHtml !== undefined) {
    if (input.bodyHtml.length > MAX_BODY_CHARS) throw new EditionError(`The body is too large (${input.bodyHtml.length} characters, max ${MAX_BODY_CHARS}).`);
    if (/<!doctype|<html[\s>]|<body[\s>]/i.test(input.bodyHtml)) {
      throw new EditionError('bodyHtml must be just the newsletter content (an HTML fragment), not a full page: the header and footer come from the template.');
    }
    if (/mc:edit\s*=/i.test(input.bodyHtml)) throw new EditionError('bodyHtml must not contain mc:edit regions; it is inserted into the template\'s body region.');
    const unsafe = unsafeHtmlProblems(input.bodyHtml);
    if (unsafe.length) throw new EditionError(`Body not saved: ${unsafe.join(' ')}`);
    if (!input.allowOffBrand) {
      const off = offBrandProblems(input.bodyHtml);
      if (off.length) {
        throw new EditionError(
          `Body not saved: it leaves Volta's dark brand style. ${off.join(' ')} Rebuild it from the Skill's building blocks and brand colours (${BRAND_SUMMARY}). Only if the editor explicitly asked for a different look, save again with allowOffBrand set to true.`,
        );
      }
    }
  }
  if (input.subject !== undefined && input.subject.length > 150) throw new EditionError('The subject line is too long (max 150 characters).');
  if (input.previewText !== undefined && input.previewText.length > 200) throw new EditionError('The preview text is too long (max 200 characters).');
  for (const [k, v] of [['windowStart', input.windowStart], ['windowEnd', input.windowEnd]] as const) {
    if (v && !DATE_ONLY.test(v)) throw new EditionError(`${k} must look like 2026-10-01.`);
  }

  const base: Edition =
    existing ?? {
      id: newEditionId(),
      label: 'Untitled edition',
      status: 'in_progress',
      windowStart: null,
      windowEnd: null,
      subject: '',
      previewText: '',
      bodyHtml: '',
      featured: [],
      campaignId: null,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    };

  const edition: Edition = {
    ...base,
    label: input.label?.trim() || base.label,
    status: input.status ?? base.status,
    windowStart: input.windowStart === undefined ? base.windowStart : input.windowStart,
    windowEnd: input.windowEnd === undefined ? base.windowEnd : input.windowEnd,
    subject: input.subject ?? base.subject,
    previewText: input.previewText ?? base.previewText,
    bodyHtml: input.bodyHtml ?? base.bodyHtml,
    featured: input.featured ? normalizeFeatured(input.featured, base.featured, now, consentResets) : base.featured,
    campaignId: input.campaignId === undefined ? base.campaignId : input.campaignId,
    updatedAt: now,
    updatedBy: by,
  };

  await persist(env, edition);

  const consentWarnings = consentProblems(edition);
  const draftWarnings =
    edition.campaignId && consentWarnings.length
      ? ['This edition already has a Mailchimp draft, and that draft may contain a story whose consent is not confirmed. create_draft will refuse to update it. Remove it with delete_draft (after checking with the user) until consent is confirmed again.']
      : [];
  return { edition, created: !existing, consentWarnings, draftWarnings, consentResets };
}

/** Returns the edition with this id, or (no id) the most recently saved one. */
export async function getEdition(env: EditionEnv, id?: string): Promise<Edition> {
  let key = id;
  if (!key) {
    key = (await env.OAUTH_KV.get(POINTER_KEY)) ?? undefined;
    if (!key) key = (await listEditions(env))[0]?.id;
    if (!key) throw new EditionError('There are no editions yet. Use save_edition to start one.');
  }
  const edition = EDITION_ID.test(key) ? ((await env.OAUTH_KV.get(`${KEY_PREFIX}${key}`, 'json')) as Edition | null) : null;
  if (!edition) throw new EditionError(`Edition "${key.slice(0, 40)}" was not found.`);
  return edition;
}

// ---- Storage ------------------------------------------------------------------
// KV `list` is eventually consistent (a key written a moment ago can be missing from
// a listing for up to a minute), so nothing that must be correct depends on it. The
// list of editions is an index document read by exact key (which is read-your-writes),
// updated on every write. Scanning `list` is only a one-time fallback that rebuilds
// the index for editions saved before the index existed.

const INDEX_KEY = 'edition:index';

const sortNewestFirst = (a: EditionSummary[]) => a.sort((x, y) => (x.id < y.id ? 1 : -1)); // ids sort by creation time

async function scanEditionKeys(env: EditionEnv): Promise<EditionSummary[]> {
  const out: EditionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list<EditionSummary>({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) if (k.metadata && k.name !== POINTER_KEY && k.name !== INDEX_KEY) out.push(k.metadata);
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return out;
}

async function readIndex(env: EditionEnv): Promise<EditionSummary[]> {
  const idx = (await env.OAUTH_KV.get(INDEX_KEY, 'json')) as EditionSummary[] | null;
  return idx ?? (await scanEditionKeys(env));
}

async function persist(env: EditionEnv, e: Edition): Promise<void> {
  const s = summarize(e);
  await env.OAUTH_KV.put(`${KEY_PREFIX}${e.id}`, JSON.stringify(e), { metadata: { ...s, subject: s.subject.slice(0, 80), label: s.label.slice(0, 80) } });
  await env.OAUTH_KV.put(POINTER_KEY, e.id);
  const index = (await readIndex(env)).filter((x) => x.id !== e.id);
  index.push({ ...s, subject: s.subject.slice(0, 80), label: s.label.slice(0, 80) });
  await env.OAUTH_KV.put(INDEX_KEY, JSON.stringify(sortNewestFirst(index)));
}

export async function listEditions(env: EditionEnv): Promise<EditionSummary[]> {
  return sortNewestFirst(await readIndex(env));
}

/** Deletes a saved edition from storage and from the index. Callers must have checked that it is safe (see deleteEdition in campaign.ts). */
export async function removeEdition(env: EditionEnv, id: string): Promise<void> {
  if (!EDITION_ID.test(id)) throw new EditionError('That does not look like an edition id.');
  const index = (await readIndex(env)).filter((x) => x.id !== id);
  await env.OAUTH_KV.put(INDEX_KEY, JSON.stringify(sortNewestFirst(index)));
  await env.OAUTH_KV.delete(`${KEY_PREFIX}${id}`);
  // "Latest edition" must never point at something that no longer exists.
  if ((await env.OAUTH_KV.get(POINTER_KEY)) === id) await env.OAUTH_KV.delete(POINTER_KEY);
}

/** Records that an edition now has a Mailchimp draft (used by create_draft). */
export async function markDrafted(
  env: EditionEnv,
  editionId: string,
  args: { campaignId: string; campaignUrl: string; by: string },
): Promise<Edition> {
  const e = await getEdition(env, editionId);
  const updated: Edition = { ...e, status: 'drafted', campaignId: args.campaignId, campaignUrl: args.campaignUrl, updatedAt: new Date().toISOString(), updatedBy: args.by };
  await persist(env, updated);
  return updated;
}

/** Forgets the Mailchimp draft link (after the draft was deleted) and reopens the edition. */
export async function clearDraft(env: EditionEnv, editionId: string, by: string): Promise<Edition> {
  const e = await getEdition(env, editionId);
  const updated: Edition = { ...e, status: 'in_progress', campaignId: null, campaignUrl: null, updatedAt: new Date().toISOString(), updatedBy: by };
  await persist(env, updated);
  return updated;
}
