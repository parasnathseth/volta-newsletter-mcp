// Tests for rate limits and the input checks that keep caller-supplied ids away from other keys/URLs.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, LIMITS, RateLimitError } from '../src/lib/rateLimit.ts';
import { saveEdition, getEdition, EditionError } from '../src/lib/edition.ts';
import { restoreVersion, updateTemplate } from '../src/lib/template.ts';
import { getReport } from '../src/lib/campaign.ts';
import { mailchimp } from '../src/lib/mailchimp.ts';

class FakeKV {
  store = new Map();
  ttls = new Map();
  async get(k, type) { const e = this.store.get(k); return e == null ? null : type === 'json' ? JSON.parse(e.value) : e.value; }
  async put(k, v, o = {}) { this.store.set(k, { value: v, metadata: o.metadata ?? null }); if (o.expirationTtl) this.ttls.set(k, o.expirationTtl); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata })), list_complete: true }; }
}

// ---------------------------------------------------------------- rate limits
test('rate limit: allows up to the limit, then refuses with a plain message', async () => {
  const env = { OAUTH_KV: new FakeKV() };
  const max = LIMITS.send_test.max;
  for (let i = 0; i < max; i++) await checkRateLimit(env, 'send_test', 'bader@voltaeffect.com');
  await assert.rejects(checkRateLimit(env, 'send_test', 'bader@voltaeffect.com'), (e) => e instanceof RateLimitError && /Too many send_test requests/.test(e.message) && new RegExp(`limit is ${max}`).test(e.message));
});

test('rate limit: is per person, per action, and resets in the next window', async () => {
  const env = { OAUTH_KV: new FakeKV() };
  const t0 = Date.parse('2026-10-01T12:00:00Z');
  for (let i = 0; i < LIMITS.send_test.max; i++) await checkRateLimit(env, 'send_test', 'a@voltaeffect.com', t0);
  await assert.rejects(checkRateLimit(env, 'send_test', 'a@voltaeffect.com', t0 + 60_000));
  await checkRateLimit(env, 'send_test', 'b@voltaeffect.com', t0); // someone else is unaffected
  await checkRateLimit(env, 'delete_draft', 'a@voltaeffect.com', t0); // another action is unaffected
  await checkRateLimit(env, 'send_test', 'a@voltaeffect.com', t0 + LIMITS.send_test.windowSeconds * 1000); // next window
  await checkRateLimit(env, 'send_test', 'A@VoltaEffect.com', t0 + LIMITS.send_test.windowSeconds * 1000); // same person, different case
});

test('rate limit: unlimited actions pass, and counters expire on their own (KV needs a TTL of at least 60 seconds)', async () => {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv };
  for (let i = 0; i < 100; i++) await checkRateLimit(env, 'get_report', 'a@voltaeffect.com');
  assert.equal(kv.store.size, 0, 'no counter is kept for actions without a limit');
  await checkRateLimit(env, 'update_template', 'a@voltaeffect.com');
  assert.ok([...kv.ttls.values()].every((t) => t >= 60));
});

test('rate limit: every risky tool has a limit configured', () => {
  for (const action of ['send_test', 'update_template', 'restore_template', 'delete_draft', 'delete_edition', 'create_draft', 'backlog_remove', 'save_edition', 'backlog_add', 'backlog_update']) {
    assert.ok(LIMITS[action]?.max > 0, action);
  }
});

test('rate limit: save_edition and backlog_add/update are capped too, so an unattended run (a manipulated search result, a stuck loop) cannot write to KV without limit', async () => {
  const env = { OAUTH_KV: new FakeKV() };
  for (const action of ['save_edition', 'backlog_add', 'backlog_update']) {
    for (let i = 0; i < LIMITS[action].max; i++) await checkRateLimit(env, action, 'scheduled@voltaeffect.com');
    await assert.rejects(checkRateLimit(env, action, 'scheduled@voltaeffect.com'), (e) => e instanceof RateLimitError, action);
  }
});

// ---------------------------------------------------------------- ids
test('edition ids: malformed ids never reach storage and reserved keys cannot be read', async () => {
  const kv = new FakeKV();
  const env = { OAUTH_KV: kv };
  const { edition } = await saveEdition(env, { label: 'x' }, 'u');
  assert.equal((await getEdition(env, edition.id)).id, edition.id);
  const reads = [];
  const spy = { ...env, OAUTH_KV: { ...kv, get: async (k, t) => { reads.push(k); return kv.get(k, t); }, put: kv.put.bind(kv), list: kv.list.bind(kv) } };
  for (const bad of ['index', 'pointer:latest', '../template:current', 'x'.repeat(26), 'edition:index', edition.id.toLowerCase(), `${edition.id}0`]) {
    await assert.rejects(getEdition(spy, bad), (e) => e instanceof EditionError && /not found/.test(e.message), JSON.stringify(bad));
    await assert.rejects(saveEdition(spy, { editionId: bad, subject: 'x' }, 'u'), /not found/);
  }
  assert.deepEqual(reads.filter((k) => k.startsWith('edition:') && k !== 'edition:pointer:latest' && k !== 'edition:index'), [], 'no storage read was attempted for a malformed id');
});

test('template version ids: malformed ids never reach storage', async () => {
  const kv = new FakeKV();
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  await kv.put('template:current', JSON.stringify({ html: '<div mc:edit="body"></div>*|UNSUB|**|LIST:ADDRESSLINE|*', mailchimpTemplateId: 1, updatedAt: 'x', updatedBy: 'x', note: '' }));
  await kv.put('template:latestVersion', 'x');
  const reads = [];
  const env = { OAUTH_KV: { ...kv, get: async (k, t) => { reads.push(k); return kv.get(k, t); }, put: kv.put.bind(kv), delete: kv.delete.bind(kv), list: kv.list.bind(kv) }, MAILCHIMP_API_KEY: 'k-us1' };
  for (const bad of ['current', '../template:current', 'latestVersion', 'versionIndex', '2026-01-01', 'x'.repeat(40), '']) {
    await assert.rejects(restoreVersion(env, '<x>', { versionId: bad, by: 'u' }), /not found/, JSON.stringify(bad));
  }
  assert.deepEqual(reads.filter((k) => k.startsWith('template:version:')), [], 'no version key was read for a malformed id');
  void updateTemplate;
});

test('campaign ids: only short alphanumeric ids may be used in Mailchimp URLs', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response('{}', { status: 200 }); };
  const env = { OAUTH_KV: new FakeKV(), MAILCHIMP_API_KEY: 'k-us20' };
  for (const bad of ['../lists/abc/members', 'abc/../../x', 'abc?x=1', 'abc#x', 'a b c d e f', '', 'abc', 'x'.repeat(30), '%2e%2e/lists']) {
    await assert.rejects(getReport(env, { campaignId: bad }), (e) => e instanceof EditionError && /campaign id/.test(e.message), JSON.stringify(bad));
  }
  assert.equal(urls.length, 0, 'Mailchimp was never contacted');
});

test('mailchimp client: the datacenter suffix must look like "us20" and the key never appears in errors', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  for (const badKey of ['secretvalue', 'secretvalue-evil.example.com/x', 'secretvalue-', 'secretvalue-US20', 'secretvalue-us2000']) {
    await assert.rejects(mailchimp({ MAILCHIMP_API_KEY: badKey }, 'GET', '/ping'), (e) => /does not look like a Mailchimp key/.test(e.message) && !e.message.includes('secretvalue'), badKey);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ title: 'Forbidden', detail: 'bad' }), { status: 403 });
  await assert.rejects(mailchimp({ MAILCHIMP_API_KEY: 'topsecretkey-us20' }, 'GET', '/ping'), (e) => !e.message.includes('topsecretkey'));
});
