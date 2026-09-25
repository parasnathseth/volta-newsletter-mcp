// Unit tests for the do-not-feature list: add, list, remove, the name check, and the tools. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { addDoNotFeature, removeDoNotFeature, getDoNotFeature, doNotFeatureProblems, DoNotFeatureError } from '../src/lib/donotfeature.ts';
import { registerDoNotFeatureTools } from '../src/tools/donotfeature.ts';
import { LIMITS } from '../src/lib/rateLimit.ts';

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
// Real Workers KV `list` is eventually consistent. This models the worst case (a listing that
// never shows anything) to prove the list never depends on it.
class StaleListKV extends FakeKV {
  async list() {
    return { keys: [], list_complete: true };
  }
}
const makeEnv = () => ({ OAUTH_KV: new FakeKV() });
const bad = (p, re) => assert.rejects(p, (e) => e instanceof DoNotFeatureError && re.test(e.message));

// ---------------------------------------------------------------- add / list / remove
test('an empty list reads as empty', async () => {
  assert.deepEqual(await getDoNotFeature(makeEnv()), []);
});

test('add stores a trimmed entry, and list returns it with its note, date and who added it', async () => {
  const env = makeEnv();
  const e = await addDoNotFeature(env, { name: '  Tidewater Maps ', note: ' asked by email on Sept 10 ' }, 'bader@voltaeffect.com');
  assert.equal(e.name, 'Tidewater Maps');
  assert.equal(e.note, 'asked by email on Sept 10');
  assert.equal(e.addedBy, 'bader@voltaeffect.com');
  assert.ok(e.id && !Number.isNaN(Date.parse(e.addedAt)));

  const list = await getDoNotFeature(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Tidewater Maps');
  assert.equal(list[0].note, 'asked by email on Sept 10');
  assert.equal(list[0].addedAt, e.addedAt);

  await addDoNotFeature(env, { name: 'Sam Lee' }, 'u'); // a note is optional
  assert.equal((await getDoNotFeature(env)).length, 2);
});

test('add refuses an empty name, a name with no letters, and names or notes that are too long', async () => {
  const env = makeEnv();
  await bad(addDoNotFeature(env, { name: '' }, 'u'), /name is required/);
  await bad(addDoNotFeature(env, { name: '    ' }, 'u'), /name is required/);
  await bad(addDoNotFeature(env, { name: 'A' }, 'u'), /name is required/);
  await bad(addDoNotFeature(env, { name: '!!!' }, 'u'), /letters or numbers/);
  await bad(addDoNotFeature(env, { name: 'x'.repeat(101) }, 'u'), /name is too long/);
  await bad(addDoNotFeature(env, { name: 'Ok Name', note: 'x'.repeat(501) }, 'u'), /note is too long/);
  assert.deepEqual(await getDoNotFeature(env), [], 'nothing was saved by the failed adds');
});

test('add refuses a duplicate, ignoring case, punctuation and spacing, and says who is already there', async () => {
  const env = makeEnv();
  await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u');
  await bad(addDoNotFeature(env, { name: 'tidewater   MAPS' }, 'u'), /"Tidewater Maps" is already on the do-not-feature list/);
  await bad(addDoNotFeature(env, { name: 'Tidewater, Maps.' }, 'u'), /already on the do-not-feature list/);
  assert.equal((await getDoNotFeature(env)).length, 1);
  await addDoNotFeature(env, { name: 'Tidewater Charts' }, 'u'); // a different name is fine
});

test('remove takes a name off (matching loosely) and returns what was removed and by whom', async () => {
  const env = makeEnv();
  await addDoNotFeature(env, { name: 'Tidewater Maps', note: 'n' }, 'u');
  await addDoNotFeature(env, { name: 'Sam Lee' }, 'u');
  const r = await removeDoNotFeature(env, ' sam  LEE ', 'bader@voltaeffect.com');
  assert.equal(r.name, 'Sam Lee');
  assert.equal(r.removedBy, 'bader@voltaeffect.com');
  assert.deepEqual((await getDoNotFeature(env)).map((e) => e.name), ['Tidewater Maps']);
  await bad(removeDoNotFeature(env, 'Sam Lee', 'u'), /not on the do-not-feature list/);
  await bad(removeDoNotFeature(env, '', 'u'), /not on the do-not-feature list/);
  await bad(removeDoNotFeature(env, 'Tidewater', 'u'), /not on the do-not-feature list/); // whole name only, no half matches
  assert.equal((await getDoNotFeature(env)).length, 1);
});

test('REGRESSION: the list is correct even when KV listings are stale (it is read by exact key, never listed)', async () => {
  const env = { OAUTH_KV: new StaleListKV() };
  await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u');
  await addDoNotFeature(env, { name: 'Sam Lee' }, 'u');
  assert.deepEqual((await getDoNotFeature(env)).map((e) => e.name), ['Tidewater Maps', 'Sam Lee']);
  await bad(addDoNotFeature(env, { name: 'sam lee' }, 'u'), /already on the do-not-feature list/); // duplicate still caught
  await removeDoNotFeature(env, 'Tidewater Maps', 'u');
  assert.deepEqual((await getDoNotFeature(env)).map((e) => e.name), ['Sam Lee']);
});

test('a failing KV read is not swallowed, so a save or draft is refused instead of let through unchecked', async () => {
  const env = { OAUTH_KV: { get: async () => { throw new Error('KV is down'); } } };
  await assert.rejects(getDoNotFeature(env), /KV is down/);
});

// ---------------------------------------------------------------- the check
const at = '2026-09-12T10:00:00.000Z';
const list = [{ name: 'Tidewater Maps', note: 'asked by email', addedAt: at }];
const clean = { featured: [{ founder: 'Jane Doe', company: 'Acme AI', topic: 'Seed round' }], bodyHtml: '<p>Hello from Volta.</p>' };

test('check: an empty list, or a clean edition, has no problems', () => {
  assert.deepEqual(doNotFeatureProblems(clean, []), []);
  assert.deepEqual(doNotFeatureProblems(clean, list), []);
  assert.deepEqual(doNotFeatureProblems({ featured: [], bodyHtml: '' }, list), []);
});

test('check: a story whose founder or company is on the list is a problem, and the message says who, why and which story', () => {
  const byCompany = doNotFeatureProblems({ ...clean, featured: [{ founder: 'Sam Lee', company: 'tidewater  maps', topic: 'Launch' }] }, list);
  assert.equal(byCompany.length, 1);
  assert.match(byCompany[0], /Tidewater Maps asked not to be featured/);
  assert.match(byCompany[0], /2026-09-12/);
  assert.match(byCompany[0], /note: asked by email/);
  assert.match(byCompany[0], /"Launch" \(Sam Lee, tidewater {2}maps\)/);

  const byFounder = doNotFeatureProblems({ ...clean, featured: [{ founder: 'Tidewater Maps', topic: 'Launch' }] }, list);
  assert.equal(byFounder.length, 1);
  assert.match(byFounder[0], /"Launch" \(Tidewater Maps\)/);
});

test('check: a name inside a longer company name or in the topic still counts, but half a name does not', () => {
  assert.equal(doNotFeatureProblems({ ...clean, featured: [{ founder: 'Sam', company: 'Tidewater Maps Inc.', topic: 'x' }] }, list).length, 1);
  assert.equal(doNotFeatureProblems({ ...clean, featured: [{ founder: 'Sam', company: 'Other', topic: 'How Tidewater Maps raised a round' }] }, list).length, 1);
  assert.deepEqual(doNotFeatureProblems({ ...clean, featured: [{ founder: 'Sam', company: 'Tidewater', topic: 'Maps for everyone' }] }, list), []);
  // Two fields glued together must not fake a match: "Tidewater" (company) + "Maps" (topic).
  assert.deepEqual(doNotFeatureProblems({ ...clean, featured: [{ founder: 'Tidewater', company: 'Maps', topic: 'x' }] }, list), []);
  // Whole words only: a short name does not match inside a longer word.
  const ada = [{ name: 'Ada', addedAt: at }];
  assert.deepEqual(doNotFeatureProblems({ ...clean, featured: [{ founder: 'Someone', company: 'Adaptive Labs', topic: 'x' }] }, ada), []);
});

test('check: the body counts, even when the name sits inside tags, entities or is split by a tag', () => {
  const body = (html) => doNotFeatureProblems({ featured: [], bodyHtml: html }, list);
  assert.match(body('<p>Congrats to Tidewater Maps on the launch!</p>')[0], /Tidewater Maps asked not to be featured.*The newsletter body names them/);
  assert.equal(body('<p style="color:#fff">Congrats <b>Tidewater</b> <i>Maps</i>!</p>').length, 1);
  assert.equal(body('<p>Tidewater&nbsp;Maps is hiring</p>').length, 1);
  assert.equal(body('<p>Tide<b>water</b> Maps is hiring</p>').length, 1);
  assert.equal(body('<img src="x.png" alt="Tidewater Maps logo">').length, 1);
  assert.equal(body('<p>tidewater<br>maps</p>').length, 1);
  // Tag and attribute text is not "visible": a class or link that happens to contain the words is fine.
  assert.deepEqual(body('<a href="https://x.test/tidewater-maps" class="tidewater maps">Read more</a>'), []);
  const amp = [{ name: 'Smith & Sons', addedAt: at }];
  assert.equal(doNotFeatureProblems({ featured: [], bodyHtml: '<p>Thanks Smith &amp; Sons</p>' }, amp).length, 1);
});

test('check: every listed name is checked, and a story plus the body give separate problems', () => {
  const two = [...list, { name: 'Sam Lee', addedAt: at }];
  const problems = doNotFeatureProblems(
    { featured: [{ founder: 'Sam Lee', company: '', topic: 'Launch' }], bodyHtml: '<p>Tidewater Maps and Sam Lee</p>' },
    two,
  );
  // Sam Lee: story + body. Tidewater Maps: body.
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /Sam Lee asked.*featured story "Launch"/.test(p)));
  assert.ok(problems.some((p) => /Sam Lee asked.*body/.test(p)));
  assert.ok(problems.some((p) => /Tidewater Maps asked.*body/.test(p)));
});

test('check: a note is optional in the message', () => {
  const p = doNotFeatureProblems({ featured: [{ founder: 'Sam Lee', topic: 'x' }], bodyHtml: '' }, [{ name: 'Sam Lee', addedAt: at }]);
  assert.match(p[0], /^Sam Lee asked not to be featured \(on the do-not-feature list since 2026-09-12\)\./);
});

// ---------------------------------------------------------------- the tools
// A stand-in for the MCP server that just remembers each tool's handler, so the tool layer can be called directly.
function loadTools(env, email = 'bader@voltaeffect.com') {
  const tools = {};
  registerDoNotFeatureTools({ registerTool: (name, config, handler) => (tools[name] = { config, handler }) }, env, () => email);
  return tools;
}
const say = async (tool, args = {}) => {
  const log = console.log;
  console.log = () => {}; // logEvent prints one JSON line per call; keep the test output clean
  try {
    const r = await tool.handler(args);
    return { text: r.content[0].text, isError: !!r.isError, json: r.isError ? null : JSON.parse(r.content[0].text) };
  } finally {
    console.log = log;
  }
};

test('tools: the three tools are registered and their descriptions say the list wins over consent', () => {
  const tools = loadTools(makeEnv());
  assert.deepEqual(Object.keys(tools).sort(), ['do_not_feature_add', 'do_not_feature_list', 'do_not_feature_remove']);
  for (const t of Object.values(tools)) assert.match(t.config.description, /WINS OVER ANY CONSENT/);
  assert.match(tools.do_not_feature_add.config.description, /only add someone when the EDITOR tells you/i);
});

test('tools: add, list and remove work end to end and show the signed-in user', async () => {
  const env = makeEnv();
  const tools = loadTools(env, 'bader@voltaeffect.com');
  const added = await say(tools.do_not_feature_add, { name: 'Tidewater Maps', note: 'asked by email' });
  assert.equal(added.json.added.addedBy, 'bader@voltaeffect.com');

  const dup = await say(tools.do_not_feature_add, { name: 'tidewater maps' });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already on the do-not-feature list/);

  const listed = await say(tools.do_not_feature_list);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.entries[0].name, 'Tidewater Maps');

  const empty = await say(tools.do_not_feature_add, { name: '  ' });
  assert.equal(empty.isError, true);

  const removed = await say(tools.do_not_feature_remove, { name: 'Tidewater Maps' });
  assert.equal(removed.json.removed.removedBy, 'bader@voltaeffect.com');
  assert.equal((await say(tools.do_not_feature_list)).json.count, 0);
  const again = await say(tools.do_not_feature_remove, { name: 'Tidewater Maps' });
  assert.equal(again.isError, true);
  assert.match(again.text, /not on the do-not-feature list/);
});

test('tools: adds and removes are rate limited once a limit is configured for them', async () => {
  // The limits live in src/lib/rateLimit.ts. Set tiny ones just for this test, then put things back.
  const before = { add: LIMITS.do_not_feature_add, remove: LIMITS.do_not_feature_remove };
  LIMITS.do_not_feature_add = { max: 2, windowSeconds: 3600 };
  LIMITS.do_not_feature_remove = { max: 1, windowSeconds: 3600 };
  try {
    const tools = loadTools(makeEnv(), 'limit-test@voltaeffect.com');
    assert.equal((await say(tools.do_not_feature_add, { name: 'One Co' })).isError, false);
    assert.equal((await say(tools.do_not_feature_add, { name: 'Two Co' })).isError, false);
    const third = await say(tools.do_not_feature_add, { name: 'Three Co' });
    assert.equal(third.isError, true);
    assert.match(third.text, /Too many do_not_feature_add requests/);
    assert.equal((await say(tools.do_not_feature_list)).json.count, 2, 'the refused add stored nothing');

    assert.equal((await say(tools.do_not_feature_remove, { name: 'One Co' })).isError, false);
    assert.match((await say(tools.do_not_feature_remove, { name: 'Two Co' })).text, /Too many do_not_feature_remove requests/);
  } finally {
    for (const [key, value] of [['do_not_feature_add', before.add], ['do_not_feature_remove', before.remove]]) {
      if (value) LIMITS[key] = value;
      else delete LIMITS[key];
    }
  }
});

// ---------------------------------------------------------------- what counts as visible text
// Odd characters are built from code points, so they cannot be lost or changed when this file is edited.
const cp = (...codes) => String.fromCodePoint(...codes);
const ZERO_WIDTH_SPACE = cp(0x200b);
const SOFT_HYPHEN = cp(0x00ad);
const FULLWIDTH_T = cp(0xff34);
const bodyProblems = (html) => doNotFeatureProblems({ featured: [], bodyHtml: html }, list);

test('REGRESSION: a stray "<" (as in "<3" or "< $5") is plain text and cannot swallow the words after it', () => {
  assert.equal(bodyProblems('<p>We <3 our founders. Congrats Tidewater Maps on the launch!</p>').length, 1);
  assert.equal(bodyProblems('<p>Tickets < $5 for Tidewater Maps fans</p>').length, 1);
  assert.equal(bodyProblems('<p>a < b and Tidewater Maps > c</p>').length, 1);
  // Real tags are still removed: tag and attribute text is not "naming" anyone.
  assert.deepEqual(bodyProblems('<p class="tidewater maps"><3 <a href="/tidewater-maps">Read</a></p>'), []);
});

test('REGRESSION: a body of 200 000 "<" is checked in well under a second (the old tag pattern took 97 seconds)', () => {
  const start = Date.now();
  assert.deepEqual(bodyProblems('<'.repeat(200_000)), []);
  assert.equal(bodyProblems(`${'<'.repeat(200_000)} Tidewater Maps`).length, 1, 'a name after all those characters is still found');
  assert.deepEqual(bodyProblems('<a '.repeat(66_000)), []);
  assert.deepEqual(bodyProblems('<!'.repeat(100_000)), []);
  assert.deepEqual(bodyProblems('<p title="'.repeat(20_000)), []);
  const took = Date.now() - start;
  assert.ok(took < 3000, `took ${took} ms`);
});

test('REGRESSION: entities, invisible characters and look-alike letters in the body cannot hide a name', () => {
  for (const html of [
    '<p>Tidew&#97;ter Maps</p>',
    '<p>Tidew&#x61;ter Maps</p>',
    '<p>Tide&shy;water Maps</p>',
    '<p>Tide&#8203;water Maps</p>',
    `<p>Tide${ZERO_WIDTH_SPACE}water Maps</p>`,
    `<p>Tide${SOFT_HYPHEN}water Maps</p>`,
    `<p>${FULLWIDTH_T}idewater Maps</p>`,
    '<p>Tide<b>&shy;</b>water Maps</p>',
    '<p>Tide<b>water</b>&nbsp;Maps</p>',
    '<img src="x.png" alt="Tidew&#97;ter Maps logo">',
  ]) {
    assert.equal(bodyProblems(html).length, 1, html);
  }
  const rene = [{ name: `Ren${cp(0x00e9)}e C${cp(0x00f4)}t${cp(0x00e9)}`, addedAt: at }]; // Renée Côté
  for (const html of ['<p>Ren&eacute;e C&ocirc;t&eacute; joins us</p>', `<p>${rene[0].name.normalize('NFD')}</p>`, '<p>Renee Cote</p>']) {
    assert.equal(doNotFeatureProblems({ featured: [], bodyHtml: html }, rene).length, 1, html);
  }
  // The same holds for a featured story's fields.
  const story = (over) => ({ featured: [{ founder: 'Sam Lee', company: '', topic: 'x', ...over }], bodyHtml: '' });
  assert.equal(doNotFeatureProblems(story({ company: 'Tidew&#97;ter Maps' }), list).length, 1);
  assert.equal(doNotFeatureProblems(story({ topic: `Tide${ZERO_WIDTH_SPACE}water Maps` }), list).length, 1);
  assert.equal(doNotFeatureProblems(story({ founder: `${FULLWIDTH_T}idewater Maps` }), list).length, 1);
});

test('REGRESSION: the subject line, preview text and label are checked too', () => {
  const edition = (over) => ({ featured: [], bodyHtml: '<p>fine</p>', ...over });
  const onlyProblem = (over, what) => {
    const p = doNotFeatureProblems(edition(over), list);
    assert.equal(p.length, 1, JSON.stringify(over));
    assert.match(p[0], new RegExp(`Tidewater Maps asked not to be featured.*The ${what} names them`));
  };
  onlyProblem({ subject: 'Big news from Tidewater Maps' }, 'subject line');
  onlyProblem({ previewText: 'Tidew&#97;ter Maps is hiring' }, 'preview text');
  onlyProblem({ label: 'Tidewater Maps special' }, 'edition label');
  assert.equal(doNotFeatureProblems(edition({ subject: 'Tidewater Maps', previewText: 'Tidewater Maps', label: 'Tidewater Maps' }), list).length, 3);
  assert.deepEqual(doNotFeatureProblems(edition({ subject: 'Volta in October', previewText: 'What is new', label: 'October' }), list), []);
  assert.deepEqual(doNotFeatureProblems(edition({}), list), [], 'fields that are left out are fine');
  assert.deepEqual(doNotFeatureProblems(edition({ subject: 'Tidewater', previewText: 'Maps' }), list), [], 'two fields are never glued together');
});

test('a long list is checked against a big body without reading the body once per name', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `Company Number ${i}`, addedAt: at }));
  const start = Date.now();
  assert.equal(doNotFeatureProblems({ featured: [], bodyHtml: `${'<p>word </p>'.repeat(15_000)}Company Number 499` }, many).length, 1);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

// ---------------------------------------------------------------- anyone signed in may change the list
const namesOf = async (env) => (await getDoNotFeature(env)).map((e) => e.name).sort();

test('any signed-in user can add and remove names', async () => {
  const env = makeEnv();
  await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'bader@voltaeffect.com');
  await addDoNotFeature(env, { name: 'Sam Lee' }, 'matt@voltaeffect.com');
  await removeDoNotFeature(env, 'tidewater maps', 'matt@voltaeffect.com');
  await removeDoNotFeature(env, 'Sam Lee', 'laura@voltaeffect.com');
  assert.deepEqual(await namesOf(env), []);
});

test('tools: another signed-in user can add and remove, and the add and remove logs carry the user and the name', async () => {
  const env = makeEnv();
  const bader = loadTools(env, 'bader@voltaeffect.com');
  const matt = loadTools(env, 'matt@voltaeffect.com');
  await say(bader.do_not_feature_add, { name: 'Tidewater Maps', note: 'asked by email' });

  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    await matt.do_not_feature_add.handler({ name: 'Sam Lee' });
    await matt.do_not_feature_remove.handler({ name: 'tidewater maps' });
  } finally {
    console.log = original;
  }
  assert.equal(lines.find((l) => l.event === 'tool.do_not_feature_add').user, 'matt@voltaeffect.com');
  const logged = lines.find((l) => l.event === 'tool.do_not_feature_remove');
  assert.equal(logged.user, 'matt@voltaeffect.com');
  assert.equal(logged.name, 'Tidewater Maps');
  assert.deepEqual(await namesOf(env), ['Sam Lee']);
  assert.ok(!/only the editor/i.test(matt.do_not_feature_add.config.description + matt.do_not_feature_remove.config.description));
});

test('tools: the input schemas cap the size of a name and a note', () => {
  const tools = loadTools(makeEnv());
  const add = z.object(tools.do_not_feature_add.config.inputSchema);
  assert.ok(add.safeParse({ name: 'x'.repeat(100), note: 'y'.repeat(500) }).success);
  assert.equal(add.safeParse({ name: 'x'.repeat(101) }).success, false);
  assert.equal(add.safeParse({ name: 'x'.repeat(1_000_000) }).success, false);
  assert.equal(add.safeParse({ name: 'Ok Name', note: 'y'.repeat(501) }).success, false);
  const remove = z.object(tools.do_not_feature_remove.config.inputSchema);
  assert.ok(remove.safeParse({ name: 'Tidewater Maps' }).success);
  assert.equal(remove.safeParse({ name: 'x'.repeat(5000) }).success, false);
});

// ---------------------------------------------------------------- calls at the same moment
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Every read and write takes a moment, so calls started together really do interleave (as on Workers KV).
class SlowKV extends FakeKV {
  async get(k, type) {
    await sleep(5);
    return super.get(k, type);
  }
  async put(k, v, opts) {
    await sleep(5);
    return super.put(k, v, opts);
  }
}
// Loses its next `lose` writes without an error, as if another call's write had landed on top of them.
class LosingKV extends FakeKV {
  lose = 0;
  async put(k, v, opts) {
    if (this.lose > 0) {
      this.lose--;
      return;
    }
    return super.put(k, v, opts);
  }
}

test('REGRESSION: three adds at the same moment all end up on the list (they used to overwrite each other)', async () => {
  for (let round = 0; round < 3; round++) {
    const env = { OAUTH_KV: new SlowKV() };
    const added = await Promise.all(['Alpha Co', 'Beta Co', 'Gamma Co'].map((name) => addDoNotFeature(env, { name }, 'u')));
    assert.deepEqual(await namesOf(env), ['Alpha Co', 'Beta Co', 'Gamma Co'], `round ${round}`);
    assert.equal(new Set(added.map((e) => e.id)).size, 3);
  }
});

test('REGRESSION: three removes at the same moment all take effect, and a remove next to an add too', async () => {
  for (let round = 0; round < 2; round++) {
    const env = { OAUTH_KV: new SlowKV() };
    for (const name of ['Alpha Co', 'Beta Co', 'Gamma Co', 'Delta Co']) await addDoNotFeature(env, { name }, 'u');
    await Promise.all(['Alpha Co', 'Beta Co', 'Gamma Co'].map((name) => removeDoNotFeature(env, name, 'u')));
    assert.deepEqual(await namesOf(env), ['Delta Co'], `round ${round}`);

    await Promise.all([addDoNotFeature(env, { name: 'Epsilon Co' }, 'u'), removeDoNotFeature(env, 'Delta Co', 'u')]);
    assert.deepEqual(await namesOf(env), ['Epsilon Co'], `round ${round}`);
  }
});

test('two adds of the SAME name at the same moment leave it on the list once; one of them is told it was already there', async () => {
  const env = { OAUTH_KV: new SlowKV() };
  const results = await Promise.allSettled([addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u'), addDoNotFeature(env, { name: 'tidewater maps' }, 'u')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected');
  assert.match(refused.reason.message, /already on the do-not-feature list/);
  assert.equal((await getDoNotFeature(env)).length, 1);
});

test('an add or remove whose write was overwritten is tried again, and does not end up twice', async () => {
  const kv = new LosingKV();
  const env = { OAUTH_KV: kv };
  kv.lose = 2;
  const added = await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u');
  await addDoNotFeature(env, { name: 'Sam Lee' }, 'u');
  assert.deepEqual((await getDoNotFeature(env)).map((e) => e.name), ['Tidewater Maps', 'Sam Lee']);
  assert.equal((await getDoNotFeature(env))[0].id, added.id);

  kv.lose = 2;
  const removed = await removeDoNotFeature(env, 'Tidewater Maps', 'u');
  assert.equal(removed.id, added.id);
  assert.deepEqual(await namesOf(env), ['Sam Lee']);
});

test('an add or remove that cannot be confirmed fails with a clear message instead of claiming success', async () => {
  const kv = new LosingKV();
  const env = { OAUTH_KV: kv };
  await addDoNotFeature(env, { name: 'Sam Lee' }, 'u');
  kv.lose = 1000;
  await bad(addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u'), /Could not confirm that "Tidewater Maps" was added.*try again/);
  await bad(removeDoNotFeature(env, 'Sam Lee', 'u'), /Could not confirm that "Sam Lee" was removed.*try again/);
  kv.lose = 0;
  assert.deepEqual(await namesOf(env), ['Sam Lee'], 'nothing changed');
});
