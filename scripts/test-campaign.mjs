// Unit tests for the Mailchimp tools' logic (drafts, consent gate, test sends, reports). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDraft, sendTest, getReport, listPastCampaigns, checkTestRecipients, deleteDraft, deleteEdition, ConsentError } from '../src/lib/campaign.ts';
import { saveEdition, getEdition, listEditions, EditionError } from '../src/lib/edition.ts';
import { addDoNotFeature, removeDoNotFeature } from '../src/lib/donotfeature.ts';

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
  async delete(k) {
    this.store.delete(k);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata }));
    return { keys, list_complete: true };
  }
}

// Fake Mailchimp: records every call and keeps campaigns in a map.
function installMailchimp(opts = {}) {
  const calls = [];
  const campaigns = new Map();
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/3.0', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, query: u.search, body });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    const noContent = () => new Response(null, { status: 204 });
    const notFound = () => json({ title: 'Resource Not Found', detail: 'nope' }, 404);

    if (method === 'GET' && path === '/lists') return json({ lists: [{ id: 'L1', name: 'Main' }, { id: 'L2', name: 'Other' }] });
    if (method === 'GET' && path === '/lists/L1') return json({ campaign_defaults: { from_name: 'Volta', from_email: 'hello@volta.test' } });
    if (method === 'POST' && path === '/campaigns') {
      const id = `C${++n}`;
      campaigns.set(id, { id, web_id: 100 + n, status: 'save', settings: body.settings });
      return json({ id, web_id: 100 + n });
    }
    let m = /^\/campaigns\/(\w+)$/.exec(path);
    if (m) {
      const c = campaigns.get(m[1]);
      if (method === 'GET') return c ? json({ id: c.id, web_id: c.web_id, status: c.status }) : notFound();
      if (method === 'PATCH') return c ? json(c) : notFound();
      if (method === 'DELETE') { campaigns.delete(m[1]); return noContent(); }
    }
    m = /^\/campaigns\/(\w+)\/content$/.exec(path);
    if (m && method === 'PUT') return campaigns.has(m[1]) ? json({}) : notFound();
    if (m && method === 'GET') return json({ plain_text: 'Hello   from\n the past ' + m[1] });
    if (/\/send-checklist$/.test(path)) return json({ is_ready: false, items: [{ type: 'success', heading: 'Ok' }, { type: 'warning', heading: 'Footer added', details: '<b>x</b> details' }] });
    if (/\/actions\/test$/.test(path)) return opts.failTest ? json({ title: 'Compliance', detail: 'not verified' }, 400) : noContent();
    m = /^\/reports\/(\w+)$/.exec(path);
    if (m) {
      if (m[1] === 'GONE') return notFound();
      return json({ campaign_title: 'Oct', subject_line: 'Hi', send_time: '2026-10-01T12:00:00+00:00', emails_sent: 40, opens: { unique_opens: 20, opens_total: 30, open_rate: 0.5 }, clicks: { unique_clicks: 5, clicks_total: 9, click_rate: 0.125 }, unsubscribed: 1, bounces: { hard_bounces: 0, soft_bounces: 2 } });
    }
    if (/\/reports\/\w+\/click-details$/.test(path)) return json({ urls_clicked: [{ url: 'https://a', total_clicks: 2, unique_clicks: 1 }, { url: 'https://b', total_clicks: 9, unique_clicks: 4 }] });
    if (method === 'GET' && path === '/campaigns') return json({ campaigns: [{ id: 'S1', send_time: '2026-09-01T00:00:00+00:00', emails_sent: 30, settings: { subject_line: 'Sept', title: 'Sept issue' }, report_summary: { open_rate: 0.4, click_rate: 0.1 } }, { id: 'S2', settings: { subject_line: 'Aug' } }] });
    return json({ title: 'Unexpected', detail: `${method} ${path}` }, 500);
  };
  return { calls, campaigns };
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET');

async function makeEnv(extra = {}) {
  const kv = new FakeKV();
  await kv.put('template:current', JSON.stringify({ html: shell, mailchimpTemplateId: 777, updatedAt: 'x', updatedBy: 'u', note: '' }));
  return { OAUTH_KV: kv, MAILCHIMP_API_KEY: 'testkey-us20', ...extra };
}

const okEdition = async (env, over = {}) =>
  (await saveEdition(env, { label: 'October', subject: 'Volta in October', previewText: 'What is new', bodyHtml: '<p>Hi</p>', ...over }, 'u')).edition;
// Every featured story needs consent AND a source link before a draft can be made.
const confirmed = { featured: [{ founder: 'Jane', company: 'Acme', topic: 'Seed', consent: 'confirmed', consentVia: 'email', sourceUrl: 'https://example.com/jane-seed' }] };

test('create_draft is blocked by unconfirmed consent and touches nothing in Mailchimp', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, { featured: [{ founder: 'Jane', company: 'Acme', topic: 'Seed' }] });
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), (err) => err instanceof ConsentError && /Jane/.test(err.message) && /not confirmed/.test(err.message));
  assert.equal(writes(calls).length, 0);
  assert.equal(calls.length, 0, 'not even a read: the gate runs first');
});

test('create_draft refuses a story with no source link, even with confirmed consent, and touches nothing in Mailchimp', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, { featured: [{ founder: 'Jane', company: 'Acme', topic: 'Seed', consent: 'confirmed', consentVia: 'email' }] });
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), (err) => err instanceof EditionError && /no source link/.test(err.message) && /"Seed" \(Jane, Acme\)/.test(err.message) && /sourceUrl/.test(err.message));
  assert.equal(calls.length, 0, 'not even a read: the gate runs first');

  // Adding the link is all it takes.
  await saveEdition(env, { editionId: e.id, featured: [{ id: 'f1', founder: 'Jane', company: 'Acme', topic: 'Seed', sourceUrl: 'https://example.com/jane-seed' }] }, 'u');
  const r = await createDraft(env, shell, { editionId: e.id, by: 'u' });
  assert.equal(r.campaignId, 'C1');
});

test('create_draft: consent is reported before the missing source link (existing consent message unchanged)', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, { featured: [{ founder: 'Jane', company: 'Acme', topic: 'Seed' }] }); // no consent, no link
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), ConsentError);
  assert.equal(calls.length, 0);
});

test('create_draft refuses when a featured story names someone on the do-not-feature list, even with confirmed consent, and touches nothing in Mailchimp', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  // The edition was saved BEFORE the person asked to be left out, so save_edition did not stop it.
  const e = await okEdition(env, { featured: [{ founder: 'Sam Lee', company: 'Tidewater Maps', topic: 'New charts', consent: 'confirmed', consentVia: 'email', sourceUrl: 'https://example.com/tidewater' }] });
  await addDoNotFeature(env, { name: 'Tidewater Maps', note: 'asked by email on Sept 10' }, 'bader@voltaeffect.com');
  await assert.rejects(
    createDraft(env, shell, { editionId: e.id, by: 'u' }),
    (err) => err instanceof EditionError && /do-not-feature list blocks/.test(err.message) && /Tidewater Maps asked not to be featured/.test(err.message) && /note: asked by email on Sept 10/.test(err.message) && /"New charts" \(Sam Lee, Tidewater Maps\)/.test(err.message),
  );
  assert.equal(calls.length, 0, 'not even a read: the gate runs first');
  assert.equal((await getEdition(env, e.id)).campaignId, null);

  // Once the name is taken off the list, the same edition goes through.
  await removeDoNotFeature(env, 'Tidewater Maps', 'u');
  assert.equal((await createDraft(env, shell, { editionId: e.id, by: 'u' })).campaignId, 'C1');
});

test('create_draft refuses when the body names someone on the do-not-feature list, and dry-run is blocked too', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv({ MAILCHIMP_DRY_RUN: 'true' });
  const e = await okEdition(env, { bodyHtml: '<p>Great news for Tidewater Maps this month.</p>' });
  await addDoNotFeature(env, { name: 'tidewater maps' }, 'u');
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), (err) => err instanceof EditionError && /The newsletter body names them/.test(err.message));
  assert.equal(calls.length, 0);
});

test('REGRESSION: create_draft refuses when the saved subject line, preview text or label names someone on the do-not-feature list', async () => {
  for (const [field, what] of [['subject', 'subject line'], ['previewText', 'preview text'], ['label', 'edition label']]) {
    const { calls } = installMailchimp();
    const env = await makeEnv();
    const e = await okEdition(env, { [field]: 'Great news for Tidewater Maps' }); // saved BEFORE the person asked to be left out
    await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u');
    await assert.rejects(
      createDraft(env, shell, { editionId: e.id, by: 'u' }),
      (err) => err instanceof EditionError && new RegExp(`The ${what} names them`).test(err.message) && /the subject line and the preview text with save_edition/.test(err.message),
      field,
    );
    assert.equal(calls.length, 0, 'not even a read: the gate runs first');

    await removeDoNotFeature(env, 'Tidewater Maps', 'u'); // once the name is off the list, the same edition goes through
    assert.equal((await createDraft(env, shell, { editionId: e.id, by: 'u' })).campaignId, 'C1', field);
  }
});

test('create_draft: the do-not-feature gate works when KV listings are stale (the list is read by exact key)', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, { bodyHtml: '<p>Great news for Tidewater Maps.</p>' });
  env.OAUTH_KV.list = async () => ({ keys: [], list_complete: true });
  await addDoNotFeature(env, { name: 'Tidewater Maps' }, 'u');
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), /do-not-feature list blocks/);
  assert.equal(calls.length, 0);
});

test('create_draft needs subject, preview text and body', async () => {
  installMailchimp();
  const env = await makeEnv();
  const e = (await saveEdition(env, { label: 'x' }, 'u')).edition;
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), (err) => err instanceof EditionError && /subject line, preview text, a body/.test(err.message));
});

test('create_draft happy path: template + body section, preview text, edition marked drafted', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  const r = await createDraft(env, shell, { editionId: e.id, by: 'u' });

  const create = calls.find((c) => c.method === 'POST' && c.path === '/campaigns');
  assert.equal(create.body.recipients.list_id, 'L1');
  assert.equal(create.body.settings.template_id, 777);
  assert.equal(create.body.settings.preview_text, 'What is new');
  assert.equal(create.body.settings.subject_line, 'Volta in October');
  assert.equal(create.body.settings.from_name, 'Volta');
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/campaigns/C1/content');
  assert.deepEqual(put.body, { template: { id: 777, sections: { body: '<p>Hi</p>' } } });
  assert.ok(!calls.some((c) => /send$|actions\/send/.test(c.path)), 'never sends');

  assert.equal(r.campaignId, 'C1');
  assert.match(r.url, /us20\.admin\.mailchimp\.com\/campaigns\/edit\?id=101/);
  assert.equal(r.sendReady, false);
  assert.ok(r.checklistProblems.some((p) => p.startsWith('warning: Footer added')));

  const saved = await getEdition(env, e.id);
  assert.equal(saved.status, 'drafted');
  assert.equal(saved.campaignId, 'C1');
});

test('re-pushing an existing draft is refused unless overwrite is confirmed (protects edits made in Mailchimp)', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  const writesBefore = writes(calls).length;
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), (err) => err instanceof EditionError && /discards any edits made directly in Mailchimp/.test(err.message) && /overwrite: true/.test(err.message));
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u', overwrite: false }), /overwrite: true/);
  assert.equal(writes(calls).length, writesBefore, 'a refused re-push writes nothing to Mailchimp');
});

test('calling create_draft again with overwrite updates the same draft (no duplicate)', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  await saveEdition(env, { editionId: e.id, bodyHtml: '<p>Updated</p>' }, 'u');
  const r = await createDraft(env, shell, { editionId: e.id, by: 'u', overwrite: true });
  assert.equal(r.reusedExistingDraft, true);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/campaigns').length, 1);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path === '/campaigns/C1'));
  const lastPut = calls.filter((c) => c.method === 'PUT').at(-1);
  assert.equal(lastPut.body.template.sections.body, '<p>Updated</p>');
});

test('a campaign that is no longer a draft is left alone', async () => {
  const { campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  campaigns.get('C1').status = 'sent';
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), /already "sent"/);
});

test('if the old draft was deleted in Mailchimp, a new one is created', async () => {
  const { calls, campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  campaigns.delete('C1');
  const r = await createDraft(env, shell, { editionId: e.id, by: 'u' });
  assert.equal(r.reusedExistingDraft, false);
  assert.equal(r.campaignId, 'C2');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/campaigns').length, 2);
});

test('dry-run validates but makes no changes in Mailchimp', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv({ MAILCHIMP_DRY_RUN: 'true' });
  const e = await okEdition(env, confirmed);
  const r = await createDraft(env, shell, { editionId: e.id, by: 'u' });
  assert.equal(r.dryRun, true);
  assert.equal(writes(calls).length, 0);
  assert.equal((await getEdition(env, e.id)).status, 'in_progress');
  // consent gate still applies in dry-run
  const blocked = await okEdition(env, { featured: [{ founder: 'X', topic: 'T' }] });
  await assert.rejects(createDraft(env, shell, { editionId: blocked.id, by: 'u' }), ConsentError);
});

test('test recipients: allowed domain only, no lookalike domains, dev extras exact', () => {
  const env = { TEST_EMAIL_ALLOWED_DOMAINS: 'voltaeffect.com', EXTRA_ALLOWED_EMAILS: 'dev@gmail.com', DEV_MODE: 'true' };
  const r = checkTestRecipients(env, ['A@VoltaEffect.com', 'x@voltaeffect.com.evil.com', 'x@evilvoltaeffect.com', 'dev@gmail.com', 'other@gmail.com', 'not-an-email', 'a@voltaeffect.com']);
  assert.deepEqual(r.allowed.map((s) => s.toLowerCase()), ['a@voltaeffect.com', 'dev@gmail.com']);
  assert.deepEqual(r.rejected, ['x@voltaeffect.com.evil.com', 'x@evilvoltaeffect.com', 'other@gmail.com', 'not-an-email']);
  assert.deepEqual(checkTestRecipients({}, ['a@voltaeffect.com']).allowed, ['a@voltaeffect.com']); // default domain
});

test('send_test refuses disallowed recipients before calling Mailchimp', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env);
  await assert.rejects(sendTest(env, shell, { editionId: e.id, to: ['me@gmail.com'] }), /only be sent to addresses at: voltaeffect\.com/);
  assert.equal(calls.length, 0);
  await assert.rejects(sendTest(env, shell, { editionId: e.id, to: [] }), /at least one/);
  await assert.rejects(sendTest(env, shell, { editionId: e.id, to: Array(6).fill('a@voltaeffect.com') }), /At most 5/);
});

test('send_test uses a temporary draft, works without consent, and cleans up', async () => {
  const { calls, campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, { featured: [{ founder: 'Jane', topic: 'Seed' }] }); // consent NOT confirmed
  const r = await sendTest(env, shell, { editionId: e.id, to: ['bader@voltaeffect.com'] });
  assert.deepEqual(r.sentTo, ['bader@voltaeffect.com']);
  const test = calls.find((c) => c.path === '/campaigns/C1/actions/test');
  assert.deepEqual(test.body, { test_emails: ['bader@voltaeffect.com'], send_type: 'html' });
  assert.equal(campaigns.size, 0, 'temporary campaign deleted');
  assert.equal((await getEdition(env, e.id)).campaignId, null, 'real edition untouched');
});

test('send_test still deletes the temporary draft when Mailchimp rejects the test send', async () => {
  const { campaigns } = installMailchimp({ failTest: true });
  const env = await makeEnv();
  const e = await okEdition(env);
  await assert.rejects(sendTest(env, shell, { editionId: e.id, to: ['bader@voltaeffect.com'] }), /Mailchimp POST .*test failed/);
  assert.equal(campaigns.size, 0);
});

test('send_test dry-run sends nothing', async () => {
  const { calls } = installMailchimp();
  const env = await makeEnv({ MAILCHIMP_DRY_RUN: 'true' });
  const e = await okEdition(env);
  const r = await sendTest(env, shell, { editionId: e.id, to: ['bader@voltaeffect.com'] });
  assert.equal(r.dryRun, true);
  assert.equal(writes(calls).length, 0);
});

test('get_report maps stats and ranks links for a sent campaign', async () => {
  const { campaigns } = installMailchimp();
  campaigns.set('camp9abc12', { id: 'camp9abc12', web_id: 9, status: 'sent' });
  const env = await makeEnv();
  const r = await getReport(env, { campaignId: 'camp9abc12' });
  assert.equal(r.sent, true);
  assert.equal(r.emailsSent, 40);
  assert.deepEqual(r.opens, { unique: 20, total: 30, rate: 0.5 });
  assert.equal(r.unsubscribes, 1);
  assert.equal(r.topLinks[0].url, 'https://b');
  await assert.rejects(getReport(env, { editionId: (await okEdition(env)).id }), /no Mailchimp campaign yet/);
});

test('get_report says sent:false for drafts and deleted campaigns instead of returning zeros', async () => {
  const { campaigns, calls } = installMailchimp();
  campaigns.set('draft1abc2', { id: 'draft1abc2', web_id: 1, status: 'save' });
  const env = await makeEnv();
  const draft = await getReport(env, { campaignId: 'draft1abc2' });
  assert.equal(draft.sent, false);
  assert.equal(draft.status, 'save');
  assert.match(draft.message, /has not been sent/);
  const gone = await getReport(env, { campaignId: 'gone12345a' });
  assert.equal(gone.sent, false);
  assert.equal(gone.status, 'not_found');
  assert.ok(!calls.some((c) => c.path.startsWith('/reports')), 'the misleading reports endpoint is never consulted for unsent campaigns');
});

test('delete_draft removes only an unsent draft and reopens the edition', async () => {
  const { calls, campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  assert.equal(campaigns.size, 1);
  const r = await deleteDraft(env, { editionId: e.id, by: 'u' });
  assert.equal(r.outcome, 'deleted');
  assert.equal(campaigns.size, 0);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/campaigns/C1'));
  const after = await getEdition(env, e.id);
  assert.equal(after.campaignId, null);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.bodyHtml, '<p>Hi</p>', 'edition content is kept');
  await assert.rejects(deleteDraft(env, { editionId: e.id, by: 'u' }), /no Mailchimp draft/);
});

test('delete_draft refuses sent campaigns, tolerates already-deleted ones, and honours dry-run', async () => {
  const { campaigns, calls } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });

  campaigns.get('C1').status = 'sent';
  await assert.rejects(deleteDraft(env, { editionId: e.id, by: 'u' }), /"sent", not a draft/);
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
  assert.equal((await getEdition(env, e.id)).campaignId, 'C1', 'link untouched when refused');

  campaigns.delete('C1');
  const gone = await deleteDraft(env, { editionId: e.id, by: 'u' });
  assert.equal(gone.outcome, 'already_gone');
  assert.equal((await getEdition(env, e.id)).campaignId, null);

  const dryEnv = await makeEnv({ MAILCHIMP_DRY_RUN: 'true' });
  const e2 = await okEdition(dryEnv, confirmed);
  await saveEdition(dryEnv, { editionId: e2.id, campaignId: 'C5' }, 'u');
  campaigns.set('C5', { id: 'C5', web_id: 5, status: 'save' });
  const dry = await deleteDraft(dryEnv, { editionId: e2.id, by: 'u' });
  assert.equal(dry.dryRun, true);
  assert.ok(campaigns.has('C5'));
});

test('withdrawing consent on an edition that already has a draft warns about the draft', async () => {
  installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  const r = await saveEdition(env, { editionId: e.id, featured: [{ id: 'f1', founder: 'Jane', topic: 'Seed', consent: 'none' }] }, 'u');
  assert.equal(r.consentWarnings.length, 1);
  assert.match(r.draftWarnings[0], /delete_draft/);
  await assert.rejects(createDraft(env, shell, { editionId: e.id, by: 'u' }), ConsentError);
  const ok = await saveEdition(env, { editionId: e.id, subject: 'Other' }, 'u'); // consent still not confirmed
  assert.equal(ok.draftWarnings.length, 1);
  const noDraft = await saveEdition(env, { label: 'fresh', featured: [{ founder: 'X', topic: 'T' }] }, 'u');
  assert.deepEqual(noDraft.draftWarnings, []);
});

test('list_past_campaigns maps summaries and optionally includes cleaned content', async () => {
  installMailchimp();
  const env = await makeEnv();
  const plain = await listPastCampaigns(env, { limit: 5, includeContent: false });
  assert.equal(plain[0].subject, 'Sept');
  assert.equal(plain[0].openRate, 0.4);
  assert.equal(plain[1].openRate, null);
  assert.equal(plain[0].text, undefined);
  const withText = await listPastCampaigns(env, { limit: 5, includeContent: true });
  assert.equal(withText[0].text, 'Hello from the past S1');
});

test('delete_edition removes an edition with no campaign, from storage, the list and the latest pointer', async () => {
  installMailchimp();
  const env = await makeEnv();
  const keep = await okEdition(env, { label: 'Keep' });
  const junk = await okEdition(env, { label: 'Junk' }); // latest
  const r = await deleteEdition(env, { editionId: junk.id });
  assert.equal(r.deleted, true);
  assert.equal(r.edition.label, 'Junk', 'the deleted content is returned');
  await assert.rejects(getEdition(env, junk.id), /not found/);
  assert.deepEqual((await listEditions(env)).map((x) => x.id), [keep.id]);
  assert.equal((await getEdition(env)).id, keep.id, 'latest no longer points at the deleted edition');
});

test('delete_edition still updates the list when KV listing shows nothing (eventual consistency)', async () => {
  installMailchimp();
  const env = await makeEnv();
  const a = await okEdition(env, { label: 'A' });
  const b = await okEdition(env, { label: 'B' });
  env.OAUTH_KV.list = async () => ({ keys: [], list_complete: true });
  await deleteEdition(env, { editionId: a.id });
  assert.deepEqual((await listEditions(env)).map((x) => x.id), [b.id]);
});

test('delete_edition refuses while a Mailchimp draft exists, and after a sent or scheduled campaign', async () => {
  const { campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  await assert.rejects(deleteEdition(env, { editionId: e.id }), /delete_draft/);
  const id = [...campaigns.keys()][0];
  for (const status of ['sent', 'schedule', 'sending']) {
    campaigns.get(id).status = status;
    await assert.rejects(deleteEdition(env, { editionId: e.id }), /kept as the record/);
  }
  assert.equal((await getEdition(env, e.id)).id, e.id, 'still there after every refusal');
});

test('delete_edition works once the draft was deleted directly in Mailchimp (404), and after delete_draft', async () => {
  const { campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  campaigns.clear(); // deleted by hand in Mailchimp
  assert.equal((await deleteEdition(env, { editionId: e.id })).deleted, true);

  const e2 = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e2.id, by: 'u' });
  await deleteDraft(env, { editionId: e2.id, by: 'u' });
  assert.equal((await deleteEdition(env, { editionId: e2.id })).deleted, true);
});

test('delete_edition refuses to guess when Mailchimp fails, and rejects missing, bad or unknown ids', async () => {
  const { campaigns } = installMailchimp();
  const env = await makeEnv();
  const e = await okEdition(env, confirmed);
  await createDraft(env, shell, { editionId: e.id, by: 'u' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ title: 'down', detail: 'x' }), { status: 500 });
  await assert.rejects(deleteEdition(env, { editionId: e.id }));
  globalThis.fetch = real;
  assert.equal((await getEdition(env, e.id)).id, e.id, 'not deleted when the status could not be checked');
  void campaigns;
  await assert.rejects(deleteEdition(env, { editionId: '' }), /required/);
  await assert.rejects(deleteEdition(env, { editionId: '../evil' }), /not found/);
  await assert.rejects(deleteEdition(env, { editionId: 'ed_doesnotexist0000000000000' }), /not found/);
});

test('delete_edition honours dry-run', async () => {
  installMailchimp();
  const env = await makeEnv({ MAILCHIMP_DRY_RUN: 'true' });
  const e = await okEdition(env);
  const r = await deleteEdition(env, { editionId: e.id });
  assert.equal(r.dryRun, true);
  assert.equal(r.deleted, false);
  assert.equal((await getEdition(env, e.id)).id, e.id);
});
