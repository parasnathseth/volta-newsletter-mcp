// Unit tests for editions, per-story consent and rendering. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { saveEdition, getEdition, listEditions, consentProblems, sourceProblems, newEditionId, EditionError } from '../src/lib/edition.ts';
import { addDoNotFeature, removeDoNotFeature } from '../src/lib/donotfeature.ts';
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

// ---------------------------------------------------------------- do-not-feature gate
const listTidewater = (env) => addDoNotFeature(env, { name: 'Tidewater Maps', note: 'asked by email on Sept 10' }, 'bader@voltaeffect.com');
const refused = (env, input, re) => assert.rejects(saveEdition(env, input, 'u'), (e) => e instanceof EditionError && re.test(e.message));
const TIDEWATER_WHY = /Tidewater Maps asked not to be featured \(on the do-not-feature list since \d{4}-\d{2}-\d{2}; note: asked by email on Sept 10\)/;

test('do-not-feature: save_edition refuses a featured story for someone on the list, says who and why, and saves nothing', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { label: 'Sept', featured: [story({ founder: 'Sam Lee', company: 'Tidewater Maps', topic: 'New charts' })] }, TIDEWATER_WHY);
  await refused(env, { label: 'Sept', featured: [story({ founder: 'Tidewater Maps', company: '', topic: 'New charts' })] }, /The featured story "New charts" \(Tidewater Maps\) names them/);
  await refused(env, { label: 'Sept', featured: [story({ topic: 'How tidewater maps got its first customer' })] }, TIDEWATER_WHY);
  // The message tells Claude not to work around it.
  await refused(env, { featured: [story({ company: 'TIDEWATER MAPS' })] }, /wins over any consent.*do not just reword.*Only the editor can change the list/s);
  await assert.rejects(getEdition(env), /no editions/, 'nothing was stored by any refused save');
  assert.deepEqual(await listEditions(env), []);
});

test('do-not-feature: the list wins over confirmed consent', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { featured: [story({ company: 'Tidewater Maps', consent: 'confirmed', consentVia: 'email' })] }, TIDEWATER_WHY);
});

test('do-not-feature: save_edition refuses a body that names someone on the list', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { bodyHtml: '<p>Congratulations to Tidewater Maps on their launch!</p>' }, /Tidewater Maps asked not to be featured.*The newsletter body names them/s);
  await refused(env, { bodyHtml: '<p>Congrats <b>Tidewater</b>&nbsp;<i>Maps</i></p>' }, /The newsletter body names them/);
  await assert.rejects(getEdition(env), /no editions/);
  // Tag and attribute text is not "naming" them.
  await saveEdition(env, { bodyHtml: '<a href="https://x.test/tidewater-maps">Read more</a>' }, 'u');
});

test('do-not-feature: refusing a save leaves the existing edition exactly as it was', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'Sept', subject: 'Hello', bodyHtml: '<p>Fine</p>', featured: [story()] }, 'u');
  await listTidewater(env);
  await refused(env, { editionId: edition.id, subject: 'Changed', featured: [story({ id: 'f1', company: 'Tidewater Maps' })] }, TIDEWATER_WHY);
  const after = await getEdition(env, edition.id);
  assert.equal(after.subject, 'Hello');
  assert.equal(after.featured[0].company, 'Acme AI');
});

test('do-not-feature: other stories and bodies save normally, and each part can be fixed on its own', async () => {
  const env = makeEnv();
  await listTidewater(env);
  const ok = await saveEdition(env, { label: 'Sept', bodyHtml: '<p>News from Volta</p>', featured: [story()] }, 'u');
  assert.equal(ok.edition.featured.length, 1);

  // An edition that already names them (added to the list later) can be repaired one part at a time.
  const kv = env.OAUTH_KV;
  const raw = JSON.parse(kv.store.get(`edition:${ok.edition.id}`).value);
  raw.bodyHtml = '<p>Tidewater Maps is great</p>';
  raw.featured[0].company = 'Tidewater Maps';
  await kv.put(`edition:${ok.edition.id}`, JSON.stringify(raw));
  const featuredFixed = await saveEdition(env, { editionId: ok.edition.id, featured: [story({ id: 'f1' })] }, 'u');
  assert.equal(featuredFixed.edition.featured[0].company, 'Acme AI');
  // The subject line is checked too now: one that names them is refused, a clean one still saves.
  await refused(env, { editionId: ok.edition.id, subject: 'News from Tidewater Maps' }, /The subject line names them/);
  const subjectOnly = await saveEdition(env, { editionId: ok.edition.id, subject: 'Still allowed' }, 'u'); // names nobody, and the old body and story are not part of this save
  assert.equal(subjectOnly.edition.subject, 'Still allowed');
  const bodyFixed = await saveEdition(env, { editionId: ok.edition.id, bodyHtml: '<p>All clear</p>' }, 'u');
  assert.equal(bodyFixed.edition.bodyHtml, '<p>All clear</p>');
});

test('do-not-feature: taking a name off the list lets the save through again', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { featured: [story({ company: 'Tidewater Maps' })] }, TIDEWATER_WHY);
  await removeDoNotFeature(env, 'tidewater maps', 'u');
  const r = await saveEdition(env, { featured: [story({ company: 'Tidewater Maps' })] }, 'u');
  assert.equal(r.edition.featured[0].company, 'Tidewater Maps');
});

test('REGRESSION: the do-not-feature gate works even when KV listings are stale (the list is read by exact key)', async () => {
  const env = { OAUTH_KV: new StaleListKV() };
  await listTidewater(env);
  await refused(env, { featured: [story({ company: 'Tidewater Maps' })] }, TIDEWATER_WHY);
  await refused(env, { bodyHtml: '<p>Tidewater Maps</p>' }, /body names them/);
});

test('REGRESSION: save_edition refuses a subject line, preview text or label that names someone on the list, and saves nothing', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { subject: 'Big news from Tidewater Maps' }, /Tidewater Maps asked not to be featured.*The subject line names them/s);
  await refused(env, { subject: 'Tidewater Maps', previewText: 'Fine' }, /The subject line names them/);
  await refused(env, { previewText: 'Tidewater Maps is hiring' }, /The preview text names them/);
  await refused(env, { previewText: 'Tidew&#97;ter Maps is hiring' }, /The preview text names them/);
  await refused(env, { label: 'Tidewater Maps special' }, /The edition label names them/);
  await refused(env, { subject: `Tide${String.fromCodePoint(0x200b)}water Maps` }, /The subject line names them/);
  // All the places are reported at once, and the message tells Claude where to look.
  await refused(env, { subject: 'Tidewater Maps', previewText: 'Tidewater Maps', bodyHtml: '<p>Tidewater Maps</p>' }, /subject line names them.*preview text names them.*body names them.*the subject line and the preview text/s);
  await assert.rejects(getEdition(env), /no editions/, 'nothing was stored by any refused save');

  // A clean subject, preview text and label are fine, and so is a name that is only half there.
  const ok = await saveEdition(env, { label: 'October', subject: 'Volta in October', previewText: 'Tidewater is on the coast' }, 'u');
  assert.equal(ok.edition.subject, 'Volta in October');

  // Refusing a save leaves the saved edition exactly as it was.
  await refused(env, { editionId: ok.edition.id, subject: 'Tidewater Maps wins', label: 'Changed' }, /The subject line names them/);
  const after = await getEdition(env, ok.edition.id);
  assert.equal(after.subject, 'Volta in October');
  assert.equal(after.label, 'October');
});

test('REGRESSION: a stray "<" in the body cannot hide a listed name from save_edition', async () => {
  const env = makeEnv();
  await listTidewater(env);
  await refused(env, { bodyHtml: '<p>We <3 our founders. Congrats Tidewater Maps on the launch!</p>' }, /The newsletter body names them/);
  await refused(env, { featured: [story({ company: 'Tidew&#97;ter Maps' })] }, TIDEWATER_WHY);
});

// ---------------------------------------------------------------- limits
test('save_edition refuses more than 50 featured stories, and takes exactly 50', async () => {
  const env = makeEnv();
  const stories = (n) => Array.from({ length: n }, (_, i) => story({ founder: `Founder ${i}`, topic: `Topic ${i}` }));
  await refused(env, { featured: stories(51) }, /Too many featured stories \(51, max 50\)/);
  await assert.rejects(getEdition(env), /no editions/);
  assert.equal((await saveEdition(env, { featured: stories(50) }, 'u')).edition.featured.length, 50);
});

// ---------------------------------------------------------------- source links
test('source links: stored trimmed, and every story without one is a warning', async () => {
  const env = makeEnv();
  const r = await saveEdition(env, { label: 'x', featured: [story({ sourceUrl: '  https://example.com/jane-seed  ' }), story({ founder: 'Sam', topic: 'Launch' })] }, 'u');
  assert.equal(r.edition.featured[0].sourceUrl, 'https://example.com/jane-seed');
  assert.equal(r.edition.featured[1].sourceUrl, null);
  assert.equal(r.sourceWarnings.length, 1);
  assert.match(r.sourceWarnings[0], /"Launch" \(Sam, Acme AI\) has no source/);
  assert.deepEqual(sourceProblems(r.edition), r.sourceWarnings);
  assert.deepEqual(sourceProblems({ featured: [] }), []);
  assert.deepEqual((await saveEdition(makeEnv(), { label: 'none' }, 'u')).sourceWarnings, []);
});

test('source links: only http(s) web addresses are accepted, and a refused save stores nothing', async () => {
  const env = makeEnv();
  const tooLong = 'https://example.com/' + 'x'.repeat(500);
  for (const url of ['javascript:alert(1)', 'ftp://example.com/x', 'example.com/no-scheme', 'https://exa mple.com', tooLong, 'not a link']) {
    await assert.rejects(saveEdition(env, { featured: [story({ sourceUrl: url })] }, 'u'), (e) => e instanceof EditionError && /source link.*http:\/\/ or https:\/\//.test(e.message), url.slice(0, 30));
  }
  await assert.rejects(getEdition(env), /no editions/);
  await saveEdition(env, { featured: [story({ sourceUrl: 'http://example.com/ok' })] }, 'u'); // plain http is allowed
});

test('REGRESSION: a source link with no real website name (such as "https://.") is refused', async () => {
  const env = makeEnv();
  for (const url of ['https://.', 'http://..', 'https://-', 'https://./page', 'https://.../a', 'http://[::]/x']) {
    await assert.rejects(saveEdition(env, { featured: [story({ sourceUrl: url })] }, 'u'), (e) => e instanceof EditionError && /source link.*a real website name/.test(e.message), url);
  }
  await assert.rejects(getEdition(env), /no editions/);
  for (const url of ['https://example.com', 'http://localhost:8787/x', 'https://a.co/x?y=1', 'http://192.168.0.1/a', 'https://xn--bcher-kva.example/']) {
    const r = await saveEdition(env, { featured: [story({ sourceUrl: url })] }, 'u');
    assert.equal(r.edition.featured[0].sourceUrl, url);
  }
});

test('source links: kept when the story is unchanged, cleared when its topic or founder changes, and can be set or cleared explicitly', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ sourceUrl: 'https://example.com/a' })] }, 'u');

  // Re-sending the story without a link, or with only case/spacing changes, keeps the link.
  const same = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: '  SEED   round ' })] }, 'u');
  assert.equal(same.edition.featured[0].sourceUrl, 'https://example.com/a');
  const otherEdit = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', company: 'Acme AI Inc.' })] }, 'u');
  assert.equal(otherEdit.edition.featured[0].sourceUrl, 'https://example.com/a');
  const untouched = await saveEdition(env, { editionId: edition.id, subject: 'Only the subject' }, 'u');
  assert.equal(untouched.edition.featured[0].sourceUrl, 'https://example.com/a');

  // A different topic means the old link no longer proves the story: cleared, and it shows as a warning.
  const topic = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Hiring their first engineer' })] }, 'u');
  assert.equal(topic.edition.featured[0].sourceUrl, null);
  assert.equal(topic.sourceWarnings.length, 1);

  // A different founder on the same id is a different story too.
  await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', sourceUrl: 'https://example.com/b' })] }, 'u');
  const founder = await saveEdition(env, { editionId: edition.id, featured: [{ id: 'f1', founder: 'Different Person', topic: 'Seed round' }] }, 'u');
  assert.equal(founder.edition.featured[0].sourceUrl, null);

  // Giving a link with the new topic is honoured; null or a blank string clears it.
  const explicit = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Opening an office', sourceUrl: 'https://example.com/c' })] }, 'u');
  assert.equal(explicit.edition.featured[0].sourceUrl, 'https://example.com/c');
  assert.equal(explicit.sourceWarnings.length, 0);
  const cleared = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Opening an office', sourceUrl: null })] }, 'u');
  assert.equal(cleared.edition.featured[0].sourceUrl, null);
  await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Opening an office', sourceUrl: 'https://example.com/d' })] }, 'u');
  const blank = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Opening an office', sourceUrl: '   ' })] }, 'u');
  assert.equal(blank.edition.featured[0].sourceUrl, null);
});

test('source links: an id-less story never inherits another story\'s link', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { label: 'x', featured: [story({ sourceUrl: 'https://example.com/a' })] }, 'u');
  const r = await saveEdition(env, { editionId: edition.id, featured: [story()] }, 'u'); // same person, no id: a new story
  assert.equal(r.edition.featured[0].sourceUrl, null);
});

test('source links: editions saved before the field existed still load, and read as having no link', async () => {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv };
  const { edition } = await saveEdition(env, { label: 'old', featured: [story({ consent: 'confirmed', consentVia: 'email', sourceUrl: 'https://example.com/a' })] }, 'u');
  const raw = JSON.parse(kv.store.get(`edition:${edition.id}`).value);
  for (const f of raw.featured) delete f.sourceUrl; // what an older stored edition looks like
  await kv.put(`edition:${edition.id}`, JSON.stringify(raw));

  const loaded = await getEdition(env, edition.id);
  assert.equal(loaded.featured[0].sourceUrl, undefined);
  assert.equal(sourceProblems(loaded).length, 1);
  assert.equal(consentProblems(loaded).length, 0, 'consent is untouched');

  const resaved = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1' })] }, 'u'); // resent without a link
  assert.equal(resaved.edition.featured[0].sourceUrl, null);
  assert.equal(resaved.edition.featured[0].consent, 'confirmed');
  const fixed = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', sourceUrl: 'https://example.com/a' })] }, 'u');
  assert.deepEqual(fixed.sourceWarnings, []);
});

test('source links do not change the list_editions summary', async () => {
  const env = makeEnv();
  await saveEdition(env, { label: 'A', featured: [story()] }, 'u');
  const [summary] = await listEditions(env);
  assert.deepEqual(Object.keys(summary).sort(), ['featuredCount', 'id', 'label', 'status', 'subject', 'unconfirmedConsent', 'updatedAt']);
  assert.equal(summary.unconfirmedConsent, 1);
});

// ---------------------------------------------------------------- source notes
test('source notes: a story with only a note has no warning; one with neither still does', async () => {
  const env = makeEnv();
  const r = await saveEdition(env, { featured: [story({ sourceNote: '  Founder emailed the details to Bader on 2026-09-25  ' }), story({ founder: 'Sam', topic: 'Launch' })] }, 'u');
  assert.equal(r.edition.featured[0].sourceNote, 'Founder emailed the details to Bader on 2026-09-25');
  assert.equal(r.sourceWarnings.length, 1);
  assert.match(r.sourceWarnings[0], /"Launch" \(Sam, Acme AI\) has no source.*sourceNote/);
  assert.deepEqual(sourceProblems({ featured: [{ topic: 't', founder: 'f', company: '', sourceUrl: null }] }).length, 1); // old stored story
  await assert.rejects(saveEdition(env, { featured: [story({ sourceNote: 'x'.repeat(501) })] }, 'u'), EditionError);
});

test('source notes: changing the topic clears the note unless it is sent again', async () => {
  const env = makeEnv();
  const { edition } = await saveEdition(env, { featured: [story({ sourceNote: 'Told to Bader in person' })] }, 'u');
  const same = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1' })] }, 'u');
  assert.equal(same.edition.featured[0].sourceNote, 'Told to Bader in person');
  const topic = await saveEdition(env, { editionId: edition.id, featured: [story({ id: 'f1', topic: 'Hiring' })] }, 'u');
  assert.equal(topic.edition.featured[0].sourceNote, null);
  assert.equal(topic.sourceWarnings.length, 1);
});
