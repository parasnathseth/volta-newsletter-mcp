// Unit tests for the calendar code. Run: npm test   (node --test, Node 24 type stripping)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIcs } from '../src/lib/ics.ts';
import { loadEvents, selectEvents, isValidBound, halifaxDate, formatLocal, defaultWindow } from '../src/lib/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const feedPath = join(here, '..', 'scratch', 'feed.ics');

class FakeKV {
  store = new Map();
  async get(k, type) {
    const v = this.store.get(k);
    return v == null ? null : type === 'json' ? JSON.parse(v) : v;
  }
  async put(k, v) {
    this.store.set(k, v);
  }
}

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
const vevent = (lines) => `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`;

test('parses folded lines, escapes, categories and UTC times', () => {
  const ics = wrap(
    vevent([
      'UID:a1',
      'SUMMARY:Coffee\\, Community',
      '  and Co-Work',
      'DTSTART:20251125T200000Z',
      'DTEND:20251125T220000Z',
      'DESCRIPTION:Line one\\nLine',
      '\ttwo\\; end',
      'LOCATION:1 Main St\\, Halifax',
      'URL:https://example.com/e',
      'CATEGORIES:Community,AI',
    ]),
  );
  const [e] = parseIcs(ics);
  assert.equal(e.title, 'Coffee, Community and Co-Work');
  assert.equal(e.description, 'Line one\nLinetwo; end');
  assert.equal(e.location, '1 Main St, Halifax');
  assert.equal(e.start, '2025-11-25T20:00:00.000Z');
  assert.deepEqual(e.categories, ['Community', 'AI']);
  assert.equal(e.url, 'https://example.com/e');
});

test('Halifax local time is correct in winter (AST) and summer (ADT)', () => {
  assert.equal(formatLocal('2025-11-25T20:00:00.000Z', false), 'Tue, Nov 25, 4:00 PM'); // UTC-4
  assert.equal(formatLocal('2026-07-15T20:00:00.000Z', false), 'Wed, Jul 15, 5:00 PM'); // UTC-3
});

test('all-day DATE values start at Halifax midnight and are flagged', () => {
  const [e] = parseIcs(wrap(vevent(['UID:d', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260101'])));
  assert.equal(e.allDay, true);
  assert.equal(halifaxDate(e.start), '2026-01-01');
});

test('floating times are treated as Halifax local', () => {
  const [e] = parseIcs(wrap(vevent(['UID:f', 'SUMMARY:X', 'DTSTART;TZID=America/Halifax:20260115T180000'])));
  assert.equal(e.start, '2026-01-15T22:00:00.000Z');
});

test('flags RRULE, ignores nested VALARM, and skips cancelled events in selection', () => {
  const ics = wrap(
    'BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Weekly\r\nDTSTART:20260105T150000Z\r\nRRULE:FREQ=WEEKLY\r\nBEGIN:VALARM\r\nSUMMARY:alarm text\r\nEND:VALARM\r\nEND:VEVENT\r\n' +
      vevent(['UID:c', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20260106T150000Z']),
  );
  const events = parseIcs(ics);
  assert.equal(events[0].hasRecurrence, true);
  assert.equal(events[0].title, 'Weekly');
  const sel = selectEvents(events, { from: '2026-01-01', to: '2026-12-31', now: Date.parse('2025-12-01'), includeDescriptions: false, limit: 50 });
  assert.deepEqual(sel.events.map((x) => x.title), ['Weekly']);
});

test('date-only bounds are inclusive by Halifax day; timestamp bounds are instants', () => {
  // 2026-03-02T02:30Z is still Mar 1 (10:30 PM) in Halifax
  const events = parseIcs(wrap(vevent(['UID:e', 'SUMMARY:Late', 'DTSTART:20260302T023000Z'])));
  const base = { now: 0, includeDescriptions: false, limit: 10 };
  assert.equal(selectEvents(events, { ...base, from: '2026-03-01', to: '2026-03-01' }).events.length, 1);
  assert.equal(selectEvents(events, { ...base, from: '2026-03-02', to: '2026-03-02' }).events.length, 0);
  assert.equal(selectEvents(events, { ...base, from: '2026-03-02T02:00:00Z', to: '2026-03-02T03:00:00Z' }).events.length, 1);
});

test('nextOccurrence points at the next later event with the same title', () => {
  const ics = wrap(
    ['a', 'b', 'c']
      .map((id, i) => vevent([`UID:${id}`, 'SUMMARY:Yoga', `URL:https://e/${id}`, `DTSTART:2026010${i + 5}T150000Z`]))
      .join(''),
  );
  const events = parseIcs(ics);
  const now = Date.parse('2026-01-05T16:00:00Z'); // after the first, before the others
  const sel = selectEvents(events, { from: '2026-01-05', to: '2026-01-05', now, includeDescriptions: false, limit: 10 });
  assert.equal(sel.events.length, 1);
  assert.equal(sel.events[0].nextOccurrence.url, 'https://e/b');
});

test('REGRESSION: the default window starts on the Halifax day, not the UTC day (evening events are not skipped)', () => {
  // 2026-09-21T00:30Z is 9:30 PM on Sep 20 in Halifax. The UTC date would be Sep 21 and skip a 7 PM Sep 20 event.
  const now = Date.parse('2026-09-21T00:30:00Z');
  const w = defaultWindow(now);
  assert.equal(w.from, '2026-09-20');
  assert.equal(w.to, '2026-10-20');
  const events = parseIcs(wrap(vevent(['UID:tonight', 'SUMMARY:Tonight', 'DTSTART:20260920T223000Z']))); // 7:30 PM Halifax on Sep 20
  assert.equal(selectEvents(events, { ...w, now, includeDescriptions: false, limit: 10 }).events.length, 1);
  // In winter (UTC-4) the same shift applies.
  assert.equal(defaultWindow(Date.parse('2026-12-15T02:00:00Z')).from, '2026-12-14');
  // Daytime is unaffected.
  assert.equal(defaultWindow(Date.parse('2026-09-20T15:00:00Z')).from, '2026-09-20');
});

test('bound validation', () => {
  assert.ok(isValidBound('2026-10-01'));
  assert.ok(isValidBound('2026-10-01T09:00:00-03:00'));
  assert.ok(!isValidBound('October 1'));
  assert.ok(!isValidBound('2026-10-01T09:00:00')); // no offset
});

test('loadEvents caches, refreshes when stale, and falls back to the stale copy on failure', async () => {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv, CALENDAR_ICS_URL: 'https://feed.test/ics' };
  const body = wrap(vevent(['UID:z', 'SUMMARY:Z', 'DTSTART:20260601T150000Z']));
  let calls = 0;
  let fail = false;
  globalThis.fetch = async () => {
    calls++;
    if (fail) throw new Error('boom');
    return new Response(body, { status: 200 });
  };

  const t0 = Date.parse('2026-05-01T00:00:00Z');
  assert.equal((await loadEvents(env, { now: t0 })).source, 'network');
  assert.equal((await loadEvents(env, { now: t0 + 10 * 60_000 })).source, 'cache');
  assert.equal(calls, 1);
  fail = true;
  const stale = await loadEvents(env, { now: t0 + 2 * 3_600_000 });
  assert.equal(stale.source, 'stale-cache');
  assert.equal(stale.events.length, 1);
  await assert.rejects(loadEvents({ OAUTH_KV: new FakeKV() }, { now: t0 }), /boom/);
});

test('real feed snapshot (skipped if scratch/feed.ics is absent)', { skip: !existsSync(feedPath) }, () => {
  const text = readFileSync(feedPath, 'utf8');
  const t = performance.now();
  const events = parseIcs(text);
  const ms = performance.now() - t;
  assert.ok(events.length > 50);
  assert.ok(events.every((e) => e.start && e.title));
  const sample = events.find((e) => e.title === 'AI Mixer and Showcase Sydney');
  assert.ok(sample, 'sample event present');
  assert.equal(formatLocal(sample.start, false), 'Tue, Nov 25, 4:00 PM'); // matches the event's own description
  console.log(`      parsed ${events.length} real events in ${ms.toFixed(2)} ms`);
});
