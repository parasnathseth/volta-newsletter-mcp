// Unit tests for editions, per-story consent and rendering. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { saveEdition, getEdition, listEditions, consentProblems, newEditionId, EditionError } from '../src/lib/edition.ts';
import { replaceRegion, renderEdition } from '../src/lib/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');

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
  async list({ prefix = '' } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata }));
    return { keys, list_complete: true };
  }
}
const makeEnv = () => ({ OAUTH_KV: new FakeKV() });
const story = (over = {}) => ({ founder: 'Jane Doe', company: 'Acme AI', topic: 'Seed round', ...over });

test('edition ids are 26 chars and sort by creation time', () => {
  const a = newEditionId(1_700_000_000_000);
  const b = newEditionId(1_700_000_001_000);
  const c = newEditionId(1_800_000_000_000);
  assert.equal(a.length, 26);
  assert.ok(a < b && b < c);
});

test('create then partial update keeps untouched fields', async () => {
  const env = makeEnv();
  const { edition, created } = await saveEdition(env, { label: 'Week 40', subject: 'Hi', bodyHtml: '<p>one</p>' }, 'a@b.c');
  assert.equal(created, true);
  const r = await saveEdition(env, { editionId: edition.id, subject: 'New subject' }, 'a@b.c');
  assert.equal(r.created, false);
  assert.equal(r.edition.subject, 'New subject');
  assert.equal(r.edition.bodyHtml, '<p>one</p>');
  assert.equal(r.edition.label, 'Week 40');
  await assert.rejects(saveEdition(env, { editionId: 'NOPE', subject: 'x' }, 'u'), /not found/);
});

test('consent is per story: none by default, confirmed needs a reason, timestamp is kept', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story(), story({ founder: 'Sam', topic: 'Launch' })] }, 'u');
  assert.deepEqual(edition.featured.map((f) => f.id), ['f1', 'f2']);
  assert.ok(edition.featured.every((f) => f.consent === 'none'));
  assert.equal(consentProblems(edition).length, 2);

  await assert.rejects(saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', consent: 'confirmed' })] }, 'u'), /consentVia/);

  const a = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', consent: 'confirmed', consentVia: 'email' }), story({ id: 'f2', founder: 'Sam', topic: 'Launch', consent: 'requested', consentVia: 'slack' })] }, 'u');
  const [f1, f2] = a.edition.featured;
  assert.equal(f1.consent, 'confirmed');
  assert.ok(f1.confirmedAt);
  assert.equal(f2.confirmedAt, null);
  assert.equal(a.consentWarnings.length, 1); // Sam still only "requested"

  // Editing something other than the topic must not re-stamp the confirmation time.
  await new Promise((r) => setTimeout(r, 5));
  const b = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', company: 'Acme AI Inc.' }), story({ id: 'f2', founder: 'Sam', topic: 'Launch' })] }, 'u');
  assert.equal(b.edition.featured[0].confirmedAt, f1.confirmedAt);
  assert.equal(b.edition.featured[0].consent, 'confirmed'); // kept from before
  assert.deepEqual(b.consentResets, []);

  // Withdrawing consent clears the confirmation.
  const c = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', consent: 'none' })] }, 'u');
  assert.equal(c.edition.featured[0].confirmedAt, null);
  assert.equal(c.edition.featured[0].consentVia, null);
});

test('changing a story\'s topic resets its consent (consent covers one specific story)', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ consent: 'confirmed', consentVia: 'email', consentNote: 'agreed to the seed round piece' })] }, 'u');
  const before = edition.featured[0];
  assert.equal(before.consent, 'confirmed');

  // Whitespace/case-only differences are the same topic.
  const same = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: '  SEED   round ' })] }, 'u');
  assert.equal(same.edition.featured[0].consent, 'confirmed');
  assert.deepEqual(same.consentResets, []);

  // A different topic, with no consent stated, resets everything about consent and says so.
  const changed = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Hiring their first engineer' })] }, 'u');
  const f = changed.edition.featured[0];
  assert.equal(f.consent, 'none');
  assert.equal(f.consentVia, null);
  assert.equal(f.confirmedAt, null);
  assert.equal(f.consentNote, '');
  assert.equal(changed.consentResets.length, 1);
  assert.match(changed.consentResets[0], /SEED\s+round.*Hiring their first engineer.*reset to "none"/i);
  assert.equal(changed.consentWarnings.length, 1);

  // Stating consent explicitly with the new topic is honoured and gets a fresh timestamp.
  await new Promise((r) => setTimeout(r, 5));
  const explicit = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Opening a second office', consent: 'confirmed', consentVia: 'in person' })] }, 'u');
  assert.equal(explicit.edition.featured[0].consent, 'confirmed');
  assert.equal(explicit.edition.featured[0].consentVia, 'in person');
  assert.notEqual(explicit.edition.featured[0].confirmedAt, before.confirmedAt);
  assert.deepEqual(explicit.consentResets, []);

  // A story with no prior consent has nothing to reset, and brand-new stories start at "none".
  const fresh = await saveEdition(env, { label: 'y', featured: [story({ topic: 'A' })] }, 'u');
  const edited = await saveEdition(env, { editionId: fresh.edition.id, featured: [story({ id: 'f1', topic: 'B' })] }, 'u');
  assert.deepEqual(edited.consentResets, []);
});

test('a story sent without its id is treated as new (consent none); omitted stories are dropped', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ consent: 'confirmed', consentVia: 'email' })] }, 'u');
  const r = await saveEdition(env, { editionId: edition.id, featured: [story()] }, 'u'); // same person, no id
  assert.equal(r.edition.featured.length, 1);
  assert.equal(r.edition.featured[0].consent, 'none');
  assert.notEqual(r.edition.featured[0].id, 'f1', 'an id-less story never reuses an existing story id');
  const dropped = await saveEdition(env, { editionId: edition.id, featured: [] }, 'u');
  assert.equal(dropped.edition.featured.length, 0);
});

test('REGRESSION: one person\'s consent can never carry over to a different person', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ consent: 'confirmed', consentVia: 'email' })] }, 'u');

  // Replacing the list with a different founder and NO ids must not inherit Jane's consent,
  // even when the topic text happens to be identical.
  const swapped = await saveEdition(env, { editionId: edition.id, featured: [{ founder: 'Someone Else', company: 'Other Co', topic: 'Seed round' }] }, 'u');
  assert.equal(swapped.edition.featured[0].consent, 'none');
  assert.equal(swapped.consentWarnings.length, 1);

  // Reusing the id with a different founder (same topic) also resets, and says why.
  const again = await saveEdition(env, { label: 'y', featured: [story({ consent: 'confirmed', consentVia: 'email', outcome: 'got two intros' })] }, 'u');
  const id = again.edition.featured[0].id;
  const reused = await saveEdition(env, { editionId: again.edition.id, featured: [{ id, founder: 'Different Person', topic: 'Seed round' }] }, 'u');
  const f = reused.edition.featured[0];
  assert.equal(f.consent, 'none');
  assert.equal(f.consentVia, null);
  assert.equal(f.company, '', 'the previous person\'s company is not carried over');
  assert.equal(f.outcome, null, 'the previous person\'s outcome is not carried over');
  assert.equal(reused.consentResets.length, 1);
  assert.match(reused.consentResets[0], /Jane Doe.*Different Person/);
});

test('re-sending the same story with its id and explicit fields keeps consent and outcome', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ consent: 'confirmed', consentVia: 'email', outcome: 'got an intro' })] }, 'u');
  const r = await saveEdition(env, { editionId: edition.id, featured: [{ id: 'f1', founder: 'jane doe', topic: 'SEED ROUND' }] }, 'u');
  const f = r.edition.featured[0];
  assert.equal(f.consent, 'confirmed');
  assert.equal(f.outcome, 'got an intro');
  assert.equal(f.confirmedAt, edition.featured[0].confirmedAt);
  assert.deepEqual(r.consentResets, []);
});

test('HTML safety looks at tags and attributes, not prose', async () => {
  const env = makeEnv();
  const ok = (body) => saveEdition(env, { bodyHtml: body }, 'u');
  await ok('<p>Learn JavaScript: the basics, and what we did once=twice at the meetup.</p>');
  await ok('<p>Working with the onboarding=process and ion= values</p>');
  await ok('<a href="https://example.com/javascript-tips" style="color:#05D9E7;">JavaScript tips</a>');
  const bad = (body, re) => assert.rejects(saveEdition(env, { bodyHtml: body }, 'u'), (e) => e instanceof EditionError && re.test(e.message));
  await bad('<a href="javascript:alert(1)">x</a>', /javascript: links/);
  await bad('<a href=" JavaScript:alert(1)">x</a>', /javascript: links/);
  await bad('<img src=javascript:alert(1)>', /javascript: links/);
  await bad('<a href="x"onclick="y()">x</a>', /event handler/);
  await bad('<div\nonmouseover="y()">x</div>', /event handler/);
  await bad('<img src="x" ONERROR="y()">', /event handler/);
  await bad('<script src="x"></script>', /Script/);
  await bad('<script/src=x>', /Script/);
});

test('an edition with no featured stories has no consent problems', async () => {
  const { edition, consentWarnings } = await saveEdition(makeEnv(), { label: 'No story this time' }, 'u');
  assert.deepEqual(consentProblems(edition), []);
  assert.deepEqual(consentWarnings, []);
});

test('rejects full pages, mc:edit regions, unsafe HTML, and bad fields', async () => {
  const env = makeEnv();
  const bad = (input, re) => assert.rejects(saveEdition(env, input, 'u'), (e) => e instanceof EditionError && re.test(e.message));
  await bad({ bodyHtml: '<html><body>x</body></html>' }, /fragment/);
  await bad({ bodyHtml: '<div mc:edit="body">x</div>' }, /mc:edit/);
  await bad({ bodyHtml: '<script>alert(1)</script>' }, /Script/);
  await bad({ bodyHtml: '<a onclick="x()">x</a>' }, /event handler/);
  await bad({ subject: 'x'.repeat(151) }, /subject/);
  await bad({ previewText: 'x'.repeat(201) }, /preview/);
  await bad({ windowStart: 'October 1' }, /windowStart/);
  await bad({ featured: [{ founder: '', topic: 't' }] }, /founder name/);
  await bad({ featured: [{ founder: 'F', topic: ' ' }] }, /topic/);
});

test('get_edition defaults to the most recently saved; list is newest first with counts', async () => {
  const env = makeEnv();
  await assert.rejects(getEdition(env), /no editions/);
  const a = await saveEdition(env, { label: 'A' }, 'u');
  await new Promise((r) => setTimeout(r, 5));
  const b = await saveEdition(env, { label: 'B', featured: [story()] }, 'u');
  assert.equal((await getEdition(env)).id, b.edition.id);
  // Saving the older one again makes it the "latest" (most recently saved).
  await saveEdition(env, { editionId: a.edition.id, subject: 'touched' }, 'u');
  assert.equal((await getEdition(env)).id, a.edition.id);
  const list = await listEditions(env);
  assert.deepEqual(list.map((e) => e.label), ['B', 'A']);
  assert.equal(list[0].unconfirmedConsent, 1);
  assert.equal(list[0].featuredCount, 1);
});

// Real Workers KV `list` is eventually consistent; model the worst case (never shows anything).
class StaleListKV extends FakeKV {
  async list() {
    return { keys: [], list_complete: true };
  }
}

test('REGRESSION: list_editions shows a just-saved edition even when KV listings are stale', async () => {
  const env = { OAUTH_KV: new StaleListKV() };
  const a = await saveEdition(env, { label: 'A' }, 'u');
  await new Promise((r) => setTimeout(r, 3));
  const b = await saveEdition(env, { label: 'B', featured: [story()] }, 'u');
  const list = await listEditions(env);
  assert.deepEqual(list.map((e) => e.label), ['B', 'A']);
  assert.equal(list[0].unconfirmedConsent, 1);
  // Updates replace the summary instead of adding a second row.
  await saveEdition(env, { editionId: a.edition.id, subject: 'now with subject' }, 'u');
  const again = await listEditions(env);
  assert.equal(again.length, 2);
  assert.equal(again.find((e) => e.label === 'A').subject, 'now with subject');
  assert.equal((await getEdition(env)).id, a.edition.id, 'latest pointer still works');
  void b;
});

test('editions saved before the index existed are found by a one-time scan, then indexed', async () => {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv };
  const legacy = { id: 'LEGACY00000000000000000AA', label: 'Legacy', status: 'in_progress', subject: 's', updatedAt: 'x', featuredCount: 0, unconfirmedConsent: 0 };
  await kv.put(`edition:${legacy.id}`, JSON.stringify({ ...legacy, featured: [], bodyHtml: '', previewText: '' }), { metadata: legacy });
  assert.deepEqual((await listEditions(env)).map((e) => e.label), ['Legacy']);
  await saveEdition(env, { label: 'New' }, 'u'); // first write builds the index including the legacy edition
  assert.deepEqual((await listEditions({ OAUTH_KV: Object.assign(kv, { list: async () => ({ keys: [], list_complete: true }) }) })).map((e) => e.label).sort(), ['Legacy', 'New']);
});

test('replaceRegion handles nested elements and ignores comments', () => {
  const html = '<!-- mc:edit="body" in a comment --><table><tr><td><div mc:edit="body"><div>old <div>deep</div></div><p>x</p></div><div>keep</div></td></tr></table>';
  const out = replaceRegion(html, 'body', '<p>NEW</p>');
  assert.equal(out, '<!-- mc:edit="body" in a comment --><table><tr><td><div mc:edit="body"><p>NEW</p></div><div>keep</div></td></tr></table>');
  assert.throws(() => replaceRegion('<div>none</div>', 'body', 'x'), /no mc:edit/);
  assert.throws(() => replaceRegion('<div mc:edit="body"><div>unclosed', 'body', 'x'), /not closed/);
});

test('renderEdition inserts the body into the real shell and fills merge tags for preview', () => {
  const body = '<div style="color:red"><p>HELLO-BODY <a href="https://x.test">link</a></p></div>';
  const html = renderEdition(shell, { bodyHtml: body, previewText: 'Preview <b>text</b>' });
  assert.ok(html.includes('HELLO-BODY'));
  assert.ok(!html.includes('Placeholder body'));
  assert.ok(html.includes('Preview &lt;b&gt;text&lt;/b&gt;'));
  assert.ok(!html.includes('*|MC_PREVIEW_TEXT|*') && !html.includes('*|UNSUB|*') && !html.includes('*|REWARDS|*'));
  assert.ok(html.includes('Volta &middot; Halifax'), 'footer is intact');
  assert.ok(html.indexOf('HELLO-BODY') < html.indexOf('Volta &middot; Halifax'), 'body comes before the footer');
});
