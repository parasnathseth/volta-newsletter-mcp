// Unit tests for template versioning. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTemplateState, updateTemplate, listVersions, restoreVersion, validateShell, shellWarnings, ValidationError, MAX_VERSIONS } from '../src/lib/template.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');

class FakeKV {
  store = new Map(); // key -> { value, metadata }
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

// Fake Mailchimp: records calls, can be told to fail PATCH.
function installMailchimp({ failPatch = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/3.0', '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    if (method === 'GET' && path === '/templates') return json({ templates: [] });
    if (method === 'POST' && path === '/templates') return json({ id: 4242 });
    if (method === 'PATCH' && path === '/templates/4242') return failPatch ? json({ title: 'Bad Request', detail: 'nope' }, 400) : json({ id: 4242 });
    return json({ title: 'Unexpected', detail: `${method} ${path}` }, 500);
  };
  return calls;
}

const makeEnv = () => ({ OAUTH_KV: new FakeKV(), MAILCHIMP_API_KEY: 'testkey-us1' });
const withText = (text) => shell.replace('Where builders get built.', text);

test('bundled shell passes validation', () => {
  assert.deepEqual(validateShell(shell), []);
});

test('validation rejects unsafe or broken templates', () => {
  assert.ok(validateShell('').length);
  assert.ok(validateShell(shell.replace('<div mc:edit="body">', '<div>')).some((p) => p.includes('exactly one')));
  assert.ok(validateShell(shell.replace('<div mc:edit="body">', '<div mc:edit="body"><div mc:edit="extra">')).some((p) => p.includes('extra')));
  assert.ok(validateShell(shell.replace('<div mc:edit="body">', '<div mc:edit="body"></div><div mc:edit="body">')).some((p) => p.includes('exactly one')));
  assert.ok(validateShell(shell.replaceAll('*|UNSUB|*', '')).some((p) => p.includes('UNSUB')));
  assert.ok(validateShell(shell.replaceAll('*|LIST:ADDRESSLINE|*', '')).some((p) => p.includes('ADDRESSLINE')));
  // Tags that appear only inside an HTML comment do not count.
  const onlyInComment = shell.replace(/<!--[\s\S]*?-->/g, '').replaceAll('*|UNSUB|*', '') + '<!-- *|UNSUB|* -->';
  assert.ok(validateShell(onlyInComment).some((p) => p.includes('UNSUB')));
  assert.ok(validateShell(shell + '<script>alert(1)</script>').some((p) => p.includes('Script')));
  assert.ok(validateShell(shell + '<a href="javascript:x()">x</a>').some((p) => p.includes('javascript')));
  assert.ok(validateShell(shell + '<a onclick="x()">x</a>').some((p) => p.includes('event handler')));
});

test('first use seeds Mailchimp and KV once', async () => {
  const calls = installMailchimp();
  const env = makeEnv();
  const a = await getTemplateState(env, shell);
  const b = await getTemplateState(env, shell);
  assert.equal(a.mailchimpTemplateId, 4242);
  assert.equal(b.html, shell);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('update saves the previous version, pushes to Mailchimp and skips no-op updates', async () => {
  const calls = installMailchimp();
  const env = makeEnv();
  const r = await updateTemplate(env, shell, { html: withText('Hello v2'), note: 'tagline', by: 'a@b.c' });
  assert.equal(r.changed, true);
  assert.equal((await getTemplateState(env, shell)).html, withText('Hello v2'));
  const versions = await listVersions(env);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].by, 'a@b.c');
  assert.match(versions[0].note, /tagline/);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.body.html === withText('Hello v2')));

  const same = await updateTemplate(env, shell, { html: withText('Hello v2'), note: 'again', by: 'a@b.c' });
  assert.equal(same.changed, false);
  assert.equal((await listVersions(env)).length, 1);
});

test('a failed Mailchimp update leaves KV unchanged and saves no version', async () => {
  installMailchimp();
  const env = makeEnv();
  await getTemplateState(env, shell);
  installMailchimp({ failPatch: true });
  await assert.rejects(updateTemplate(env, shell, { html: withText('X'), note: 'x', by: 'u' }), /Mailchimp PATCH/);
  assert.equal((await getTemplateState(env, shell)).html, shell);
  assert.equal((await listVersions(env)).length, 0);
});

test('invalid HTML is rejected before anything is written', async () => {
  const calls = installMailchimp();
  const env = makeEnv();
  await assert.rejects(updateTemplate(env, shell, { html: '<p>nope</p>', note: 'x', by: 'u' }), ValidationError);
  assert.equal(calls.length, 0);
});

test(`only the newest ${MAX_VERSIONS} versions are kept after many updates`, async () => {
  installMailchimp();
  const env = makeEnv();
  for (let i = 1; i <= 12; i++) await updateTemplate(env, shell, { html: withText(`v${i}`), note: `change ${i}`, by: 'u' });
  const versions = await listVersions(env);
  assert.equal(versions.length, MAX_VERSIONS);
  assert.match(versions[0].note, /change 12/); // newest first
});

test('restore "previous" undoes the last update, and the restore is itself undoable', async () => {
  installMailchimp();
  const env = makeEnv();
  await updateTemplate(env, shell, { html: withText('one'), note: 'one', by: 'u' });
  await updateTemplate(env, shell, { html: withText('two'), note: 'two', by: 'u' });
  const r = await restoreVersion(env, shell, { versionId: 'previous', by: 'u' });
  assert.equal(r.changed, true);
  assert.equal((await getTemplateState(env, shell)).html, withText('one'));
  const again = await restoreVersion(env, shell, { versionId: 'previous', by: 'u' }); // undo the restore
  assert.equal((await getTemplateState(env, shell)).html, withText('two'));
  assert.ok(again.changed);
});

test('restore by explicit id, and unknown ids are reported', async () => {
  installMailchimp();
  const env = makeEnv();
  await updateTemplate(env, shell, { html: withText('one'), note: 'one', by: 'u' });
  const [v] = await listVersions(env);
  await updateTemplate(env, shell, { html: withText('two'), note: 'two', by: 'u' });
  await restoreVersion(env, shell, { versionId: v.versionId, by: 'u' });
  assert.equal((await getTemplateState(env, shell)).html, shell); // the version saved before "one" was the original shell
  await assert.rejects(restoreVersion(env, shell, { versionId: 'nope', by: 'u' }), /not found/);
});

class StaleListKV extends FakeKV {
  // Real Workers KV `list` is eventually consistent; model the worst case (never shows anything).
  async list() {
    return { keys: [], list_complete: true };
  }
}

test('REGRESSION: version history and pruning stay correct when KV listings are stale', async () => {
  installMailchimp();
  const env = { OAUTH_KV: new StaleListKV(), MAILCHIMP_API_KEY: 'testkey-us1' };
  for (let i = 1; i <= 13; i++) await updateTemplate(env, shell, { html: withText(`v${i}`), note: `change ${i}`, by: 'u' });
  const versions = await listVersions(env);
  assert.equal(versions.length, MAX_VERSIONS);
  assert.match(versions[0].note, /change 13/);
  assert.match(versions.at(-1).note, /change 4/, 'oldest three were pruned');
  const versionKeys = [...env.OAUTH_KV.store.keys()].filter((k) => k.startsWith('template:version:'));
  assert.equal(versionKeys.length, MAX_VERSIONS, 'pruned versions are really deleted from storage');
  const r = await restoreVersion(env, shell, { versionId: 'previous', by: 'u' });
  assert.equal(r.changed, true);
});

test('version history saved before the index existed is found by a one-time scan, then indexed', async () => {
  installMailchimp();
  const kv = new FakeKV();
  await kv.put('template:version:2026-01-01T00:00:00.000Z-aaaa', JSON.stringify({ html: shell }), { metadata: { createdAt: '2026-01-01T00:00:00.000Z', by: 'old', note: 'legacy', bytes: 10 } });
  const env = { OAUTH_KV: kv, MAILCHIMP_API_KEY: 'testkey-us1' };
  assert.deepEqual((await listVersions(env)).map((v) => v.note), ['legacy']);
  await updateTemplate(env, shell, { html: withText('new'), note: 'fresh', by: 'u' });
  kv.list = async () => ({ keys: [], list_complete: true }); // listings go stale afterwards
  assert.deepEqual((await listVersions(env)).map((v) => v.note), ['before: fresh'.replace('before: ', ''), 'legacy']);
});

test('restore "previous" with no history explains itself', async () => {
  installMailchimp();
  await assert.rejects(restoreVersion(makeEnv(), shell, { versionId: 'previous', by: 'u' }), /no previous version/);
});

test('version metadata reports UTF-8 bytes, not characters', async () => {
  installMailchimp();
  const env = makeEnv();
  await updateTemplate(env, shell, { html: withText('Hello'), note: 'n', by: 'u' });
  const [v] = await listVersions(env);
  assert.equal(v.bytes, new TextEncoder().encode(shell).length);
  assert.ok(v.bytes > shell.length, 'shell contains multi-byte characters (em dash), so bytes > characters');
});

test('missing *|REWARDS|* is a warning, not an error', async () => {
  installMailchimp();
  const noRewards = shell.replaceAll('*|REWARDS|*', '');
  assert.deepEqual(validateShell(noRewards), []);
  assert.equal(shellWarnings(noRewards).length, 1);
  assert.deepEqual(shellWarnings(shell), []);
  const r = await updateTemplate(makeEnv(), shell, { html: noRewards, note: 'x', by: 'u' });
  assert.equal(r.changed, true);
  assert.equal(r.warnings.length, 1);
});
