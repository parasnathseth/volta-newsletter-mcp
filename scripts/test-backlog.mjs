// Unit tests for the founder backlog, including deletes. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, listEntries, updateEntry, removeEntry, BacklogError } from '../src/lib/backlog.ts';
import { saveEdition, getEdition, listEditions } from '../src/lib/edition.ts';

class FakeKV {
  store = new Map();
  async get(k, type) {
    const e = this.store.get(k);
    if (!e) return null;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async put(k, v, opts = {}) {
    this.store.set(k, { value: v, metadata: opts.metadata ?? null });
  }
  async delete(k) {
    this.store.delete(k);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata }));
    return { keys, list_complete: true };
  }
}
// Real Workers KV `list` is eventually consistent: keys (and their metadata) written a
// moment ago can be missing from a listing for up to a minute. This models the worst
// case, a listing that never shows anything, to prove correctness never depends on it.
class StaleListKV extends FakeKV {
  async list() {
    return { keys: [], list_complete: true };
  }
}
const makeEnv = () => ({ OAUTH_KV: new FakeKV() });
const makeStaleEnv = () => ({ OAUTH_KV: new StaleListKV() });
const bad = (p, re) => assert.rejects(p, (e) => e instanceof BacklogError && re.test(e.message));
const wait = () => new Promise((r) => setTimeout(r, 3)); // ids sort by creation time

test('add stores a trimmed entry with sensible defaults', async () => {
  const env = makeEnv();
  const e = await addEntry(env, { founder: '  Jane Doe ', company: ' Acme AI ', note: ' just raised seed ', links: ['https://acme.ai', 'https://acme.ai', 'https://linkedin.com/in/jane'] }, 'bader@voltaeffect.com');
  assert.equal(e.founder, 'Jane Doe');
  assert.equal(e.company, 'Acme AI');
  assert.equal(e.note, 'just raised seed');
  assert.deepEqual(e.links, ['https://acme.ai', 'https://linkedin.com/in/jane']); // de-duplicated
  assert.equal(e.status, 'idea');
  assert.equal(e.revisitDate, null);
  assert.equal(e.updatedBy, 'bader@voltaeffect.com');
  assert.ok(!('consent' in e), 'the backlog never records consent');
});

test('add rejects duplicates (case and spacing insensitive) and points at the existing entry', async () => {
  const env = makeEnv();
  const a = await addEntry(env, { founder: 'Jane Doe', company: 'Acme AI' }, 'u');
  await bad(addEntry(env, { founder: 'jane   DOE', company: 'acme ai' }, 'u'), new RegExp(`already in the backlog.*${a.id}`));
  await addEntry(env, { founder: 'Jane Doe', company: 'Other Co' }, 'u'); // same person, different company is fine
});

test('add validates its fields', async () => {
  const env = makeEnv();
  await bad(addEntry(env, { founder: '   ' }, 'u'), /founder name/);
  await bad(addEntry(env, { founder: 'x'.repeat(101) }, 'u'), /founder name/);
  await bad(addEntry(env, { founder: 'A', note: 'x'.repeat(2001) }, 'u'), /note is too long/);
  await bad(addEntry(env, { founder: 'A', revisitDate: 'next spring' }, 'u'), /real date/);
  await bad(addEntry(env, { founder: 'A', revisitDate: '2027-02-30' }, 'u'), /real date/);
  await bad(addEntry(env, { founder: 'A', links: ['javascript:alert(1)'] }, 'u'), /not a valid http/);
  await bad(addEntry(env, { founder: 'A', links: ['not a link'] }, 'u'), /not a valid http/);
  await bad(addEntry(env, { founder: 'A', links: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) }, 'u'), /At most 10/);
  assert.equal((await listEntries(env, { status: 'all' })).total, 0, 'nothing was saved by the failed adds');
});

test('list: defaults to ideas, sorts by revisit date then newest, supports status, dueBy, query and limit', async () => {
  const env = makeEnv();
  const late = await addEntry(env, { founder: 'Late', revisitDate: '2027-06-01' }, 'u'); await wait();
  const soon = await addEntry(env, { founder: 'Soon', revisitDate: '2026-11-01', note: 'Halifax biotech' }, 'u'); await wait();
  const undated1 = await addEntry(env, { founder: 'Undated One', company: 'Alpha' }, 'u'); await wait();
  const undated2 = await addEntry(env, { founder: 'Undated Two', company: 'Beta', links: ['https://beta.io'] }, 'u'); await wait();
  const shelved = await addEntry(env, { founder: 'Shelved' }, 'u');
  await updateEntry(env, { id: shelved.id, status: 'passed' }, 'u');

  const def = await listEntries(env, {});
  assert.deepEqual(def.entries.map((e) => e.founder), ['Soon', 'Late', 'Undated Two', 'Undated One']);
  assert.equal(def.total, 4);

  assert.deepEqual((await listEntries(env, { status: 'passed' })).entries.map((e) => e.founder), ['Shelved']);
  assert.equal((await listEntries(env, { status: 'all' })).total, 5);
  assert.deepEqual((await listEntries(env, { dueBy: '2026-12-31' })).entries.map((e) => e.founder), ['Soon']);
  assert.deepEqual((await listEntries(env, { dueBy: '2027-06-01' })).entries.map((e) => e.founder), ['Soon', 'Late']);
  assert.deepEqual((await listEntries(env, { query: 'biotech' })).entries.map((e) => e.founder), ['Soon']); // note
  assert.deepEqual((await listEntries(env, { query: 'ALPHA' })).entries.map((e) => e.founder), ['Undated One']); // company
  assert.deepEqual((await listEntries(env, { query: 'beta.io' })).entries.map((e) => e.founder), ['Undated Two']); // link
  const limited = await listEntries(env, { limit: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.total, 4, 'total counts matches before the limit');
  await bad(listEntries(env, { dueBy: 'soon' }), /real date/);
  void late; void undated1;
});

test('update changes only what is passed, appends dated notes, and can clear the revisit date', async () => {
  const env = makeEnv();
  const e = await addEntry(env, { founder: 'Jane', company: 'Acme', note: 'first note', revisitDate: '2027-01-15', links: ['https://a.io'] }, 'u');

  const a = await updateEntry(env, { id: e.id, appendNote: 'raised a seed round' }, 'bader');
  assert.match(a.note, /^first note\n\d{4}-\d{2}-\d{2}: raised a seed round$/);
  assert.equal(a.company, 'Acme');
  assert.deepEqual(a.links, ['https://a.io']);
  assert.equal(a.updatedBy, 'bader');

  const b = await updateEntry(env, { id: e.id, note: 'replaced', revisitDate: null, links: [] }, 'u');
  assert.equal(b.note, 'replaced');
  assert.equal(b.revisitDate, null);
  assert.deepEqual(b.links, []);

  await bad(updateEntry(env, { id: e.id, revisitDate: '2027-13-01' }, 'u'), /real date/);
  await bad(updateEntry(env, { id: 'NOPE', note: 'x' }, 'u'), /No backlog entry/);
  await bad(updateEntry(env, { id: e.id, appendNote: 'x'.repeat(2500) }, 'u'), /too long/);
  assert.equal((await listEntries(env, { status: 'all' })).entries[0].note, 'replaced', 'failed updates change nothing');
});

test('renaming into an existing person is refused', async () => {
  const env = makeEnv();
  await addEntry(env, { founder: 'Jane', company: 'Acme' }, 'u');
  const other = await addEntry(env, { founder: 'Sam', company: 'Beta' }, 'u');
  await bad(updateEntry(env, { id: other.id, founder: 'jane', company: 'acme' }, 'u'), /already exists/);
  const ok = await updateEntry(env, { id: other.id, company: 'Beta Labs' }, 'u');
  assert.equal(ok.company, 'Beta Labs');
});

test('recording a feature marks the entry featured and removes it from the default list', async () => {
  const env = makeEnv();
  const e = await addEntry(env, { founder: 'Jane' }, 'u');
  const f = await updateEntry(env, { id: e.id, featuredInEditionId: 'ED1' }, 'u');
  await updateEntry(env, { id: e.id, featuredInEditionId: 'ED1' }, 'u'); // idempotent
  await updateEntry(env, { id: e.id, featuredInEditionId: 'ED2' }, 'u');
  assert.equal(f.status, 'featured');
  const now = (await listEntries(env, { status: 'all' })).entries[0];
  assert.deepEqual(now.featuredInEditions, ['ED1', 'ED2']);
  assert.equal((await listEntries(env, {})).total, 0);
  assert.equal((await listEntries(env, { status: 'featured' })).total, 1);
});

test('remove permanently deletes exactly one entry and returns it', async () => {
  const env = makeEnv();
  const a = await addEntry(env, { founder: 'Keep Me' }, 'u');
  const b = await addEntry(env, { founder: 'Delete Me', note: 'added by mistake' }, 'u');
  const c = await addEntry(env, { founder: 'Keep Me Too' }, 'u');

  const removed = await removeEntry(env, b.id);
  assert.equal(removed.founder, 'Delete Me');
  assert.equal(removed.note, 'added by mistake', 'the removed entry is returned in full so it can be re-added');

  const left = await listEntries(env, { status: 'all' });
  assert.deepEqual(left.entries.map((e) => e.id).sort(), [a.id, c.id].sort());
  const doc = await env.OAUTH_KV.get('backlog:all', 'json');
  assert.ok(!JSON.stringify(doc).includes(b.id) && !JSON.stringify(doc).includes('Delete Me'), 'gone from storage, not just hidden');
  assert.equal((await listEntries(env, { query: 'delete me' })).total, 0);
});

test('remove of an unknown or already-deleted id is an error and touches nothing', async () => {
  const env = makeEnv();
  const a = await addEntry(env, { founder: 'Only One' }, 'u');
  await bad(removeEntry(env, 'NOPE'), /No backlog entry/);
  await removeEntry(env, a.id);
  await bad(removeEntry(env, a.id), /No backlog entry/); // second delete
  await bad(updateEntry(env, { id: a.id, note: 'x' }, 'u'), /No backlog entry/); // cannot update a deleted entry
  assert.equal((await listEntries(env, { status: 'all' })).total, 0);
});

test('a removed person can be re-added (no duplicate block after deletion)', async () => {
  const env = makeEnv();
  const a = await addEntry(env, { founder: 'Jane', company: 'Acme' }, 'u');
  await removeEntry(env, a.id);
  const again = await addEntry(env, { founder: 'Jane', company: 'Acme' }, 'u');
  assert.notEqual(again.id, a.id);
});

test('REGRESSION: duplicates are blocked and dueBy works immediately even when KV listings are stale', async () => {
  const env = makeStaleEnv();
  const a = await addEntry(env, { founder: 'Jane Doe', company: 'Acme AI' }, 'u');
  // The failure seen in production: a second identical add succeeded seconds later.
  await bad(addEntry(env, { founder: 'Jane Doe', company: 'Acme AI' }, 'u'), new RegExp(`already in the backlog.*${a.id}`));
  await addEntry(env, { founder: 'Alpha', revisitDate: '2026-09-18' }, 'u');
  // The other production failure: dueBy right after an add returned nothing.
  const due = await listEntries(env, { dueBy: '2026-09-20' });
  assert.deepEqual(due.entries.map((e) => e.founder), ['Alpha']);
  assert.equal((await listEntries(env, { status: 'all' })).total, 2);
  await updateEntry(env, { id: a.id, appendNote: 'hello' }, 'u');
  await removeEntry(env, a.id);
  assert.equal((await listEntries(env, { status: 'all' })).total, 1);
  // A genuinely blocked duplicate, then re-add after removal (so re-add is distinguishable from a missing check).
  await bad(addEntry(env, { founder: 'alpha' }, 'u'), /already in the backlog/);
  await removeEntry(env, (await listEntries(env, { status: 'all' })).entries[0].id);
  await addEntry(env, { founder: 'Alpha' }, 'u');
});

test('duplicate rule holds across many rapid adds and only allows one of two identical adds', async () => {
  const env = makeStaleEnv();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await addEntry(env, { founder: 'Same Person', company: 'Same Co' }, 'u').then(() => 'added', () => 'refused'));
  assert.deepEqual(results, ['added', 'refused', 'refused', 'refused', 'refused']);
});

test('removing a backlog entry never touches editions', async () => {
  const env = makeEnv();
  const entry = await addEntry(env, { founder: 'Jane', company: 'Acme' }, 'u');
  const { edition } = await saveEdition(env, { label: 'Oct', subject: 'S', featured: [{ founder: 'Jane', company: 'Acme', topic: 'Seed', consent: 'confirmed', consentVia: 'email' }] }, 'u');
  await updateEntry(env, { id: entry.id, featuredInEditionId: edition.id }, 'u');

  await removeEntry(env, entry.id);

  const ed = await getEdition(env, edition.id);
  assert.equal(ed.featured[0].consent, 'confirmed');
  assert.equal((await listEditions(env)).length, 1);
});
