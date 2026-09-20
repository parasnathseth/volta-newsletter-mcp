import { EVENT_TIME_ZONE, parseIcs, type IcsEvent } from './ics.ts';

export const DEFAULT_ICS_URL = 'https://calendar.voltaeffect.com/api/calendar/ics';
const CACHE_KEY = 'cache:events:v1';
const FRESH_MS = 60 * 60 * 1000; // matches the feed's X-PUBLISHED-TTL of one hour
const STALE_TTL_SECONDS = 24 * 60 * 60; // keep a stale copy as a fallback if the feed is down
const MAX_DESCRIPTION_CHARS = 600;

export interface EventsEnv {
  OAUTH_KV: KVNamespace;
  CALENDAR_ICS_URL?: string;
}

interface CacheValue {
  fetchedAt: string;
  events: IcsEvent[];
}

export type EventSource = 'cache' | 'network' | 'stale-cache';

// The feed is large (about 180 KB) and slow to download (about 7 s measured), so
// the parsed result is cached in KV. Descriptions are trimmed before caching.
export async function loadEvents(
  env: EventsEnv,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<{ events: IcsEvent[]; fetchedAt: string; source: EventSource }> {
  const now = opts.now ?? Date.now();
  const cached = (await env.OAUTH_KV.get(CACHE_KEY, 'json')) as CacheValue | null;

  if (cached && !opts.refresh && now - Date.parse(cached.fetchedAt) < FRESH_MS) {
    return { events: cached.events, fetchedAt: cached.fetchedAt, source: 'cache' };
  }

  try {
    const res = await fetch(env.CALENDAR_ICS_URL || DEFAULT_ICS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`calendar feed returned HTTP ${res.status}`);
    const events = parseIcs(await res.text()).map((e) => ({
      ...e,
      description: e.description.replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_CHARS),
    }));
    const fresh: CacheValue = { fetchedAt: new Date(now).toISOString(), events };
    await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: STALE_TTL_SECONDS });
    return { events, fetchedAt: fresh.fetchedAt, source: 'network' };
  } catch (err) {
    if (cached) return { events: cached.events, fetchedAt: cached.fetchedAt, source: 'stale-cache' };
    throw err;
  }
}

// ---- Halifax-local formatting -------------------------------------------------

const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: EVENT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dateTimeLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** YYYY-MM-DD of an instant in America/Halifax. */
export function halifaxDate(iso: string): string {
  const p = Object.fromEntries(dateParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Default event window: today (Halifax calendar day) through 30 days later. Using the UTC date here would skip this evening's events after 8-9 pm Halifax time. */
export function defaultWindow(now: number): { from: string; to: string } {
  return { from: halifaxDate(new Date(now).toISOString()), to: halifaxDate(new Date(now + 30 * 86_400_000).toISOString()) };
}

export function formatLocal(iso: string, allDay: boolean): string {
  return (allDay ? dateLabel : dateTimeLabel).format(new Date(iso));
}

// ---- Filtering ----------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidBound(v: string): boolean {
  return DATE_ONLY.test(v) || (DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)));
}

// A bound is either a date (YYYY-MM-DD, compared against the event's Halifax
// calendar day, inclusive) or a full ISO timestamp with offset (an instant).
function inBounds(startIso: string, from: string, to: string): boolean {
  const afterFrom = DATE_ONLY.test(from) ? halifaxDate(startIso) >= from : Date.parse(startIso) >= Date.parse(from);
  const beforeTo = DATE_ONLY.test(to) ? halifaxDate(startIso) <= to : Date.parse(startIso) <= Date.parse(to);
  return afterFrom && beforeTo;
}

const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

export interface EventOut {
  uid: string;
  title: string;
  start: string;
  end: string | null;
  startLocal: string;
  date: string;
  allDay: boolean;
  location: string;
  url: string | null;
  categories: string[];
  description?: string;
  nextOccurrence?: { start: string; startLocal: string; url: string | null };
  hasRecurrence?: true;
}

export function selectEvents(
  events: IcsEvent[],
  opts: { from: string; to: string; now: number; includeDescriptions: boolean; limit: number },
): { events: EventOut[]; totalMatching: number } {
  const usable = events.filter((e) => e.start && e.status !== 'CANCELLED');
  const sorted = [...usable].sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));

  // Later occurrences of the same title, for "sign up for the next one" links.
  const futureByTitle = new Map<string, IcsEvent[]>();
  for (const e of sorted) {
    if (Date.parse(e.start!) > opts.now) {
      const k = normTitle(e.title);
      (futureByTitle.get(k) ?? futureByTitle.set(k, []).get(k)!).push(e);
    }
  }

  const matching = sorted.filter((e) => inBounds(e.start!, opts.from, opts.to));
  const out: EventOut[] = matching.slice(0, opts.limit).map((e) => {
    const next = futureByTitle.get(normTitle(e.title))?.find((f) => Date.parse(f.start!) > Date.parse(e.start!));
    const item: EventOut = {
      uid: e.uid,
      title: e.title,
      start: e.start!,
      end: e.end,
      startLocal: formatLocal(e.start!, e.allDay),
      date: halifaxDate(e.start!),
      allDay: e.allDay,
      location: e.location,
      url: e.url,
      categories: e.categories,
    };
    if (opts.includeDescriptions) item.description = e.description;
    if (next) item.nextOccurrence = { start: next.start!, startLocal: formatLocal(next.start!, next.allDay), url: next.url };
    if (e.hasRecurrence) item.hasRecurrence = true;
    return item;
  });
  return { events: out, totalMatching: matching.length };
}
