// LIVE end-to-end test against the real Mailchimp sandbox account (KV is faked in memory).
// Exercises create_draft -> re-push -> consent withdrawal -> delete_draft -> already-gone,
// using the real library code. Never sends anything. Uses its own throwaway template and
// deletes everything it creates, so the real "Volta Newsletter Shell" template is untouched.
// Run: npm run live:drafts      (needs MAILCHIMP_API_KEY in .dev.vars)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDraft, deleteDraft, ConsentError } from '../src/lib/campaign.ts';
import { saveEdition, getEdition } from '../src/lib/edition.ts';
import { mailchimp } from '../src/lib/mailchimp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
const key = process.env.MAILCHIMP_API_KEY;
if (!key) { console.error('MAILCHIMP_API_KEY missing (put it in .dev.vars and run with --env-file=.dev.vars)'); process.exit(1); }

class FakeKV {
  store = new Map();
  async get(k, type) { const e = this.store.get(k); return e == null ? null : type === 'json' ? JSON.parse(e.value) : e.value; }
  async put(k, v, o = {}) { this.store.set(k, { value: v, metadata: o.metadata ?? null }); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata })), list_complete: true }; }
}

const env = { OAUTH_KV: new FakeKV(), MAILCHIMP_API_KEY: key };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const statusOf = async (id) => { try { return (await mailchimp(env, 'GET', `/campaigns/${id}?fields=id,status`)).status; } catch (e) { return e.status === 404 ? 'gone' : `error ${e.status}`; } };
const throws = async (fn, Cls) => { try { await fn(); return null; } catch (e) { return Cls && !(e instanceof Cls) ? null : e; } };

const createdCampaigns = new Set();
let templateId = null;
try {
  const tpl = await mailchimp(env, 'POST', '/templates', { name: 'zz live lifecycle test (auto-deleted)', html: shell });
  templateId = tpl.id;
  await env.OAUTH_KV.put('template:current', JSON.stringify({ html: shell, mailchimpTemplateId: templateId, updatedAt: 'x', updatedBy: 'test', note: '' }));

  const confirmed = [{ founder: 'Test Founder', company: 'Test Co', topic: 'Live lifecycle test', consent: 'confirmed', consentVia: 'test script' }];
  const { edition } = await saveEdition(env, { label: 'Live lifecycle test', subject: 'Lifecycle test', previewText: 'Please ignore', bodyHtml: '<p>Lifecycle test body</p>', featured: confirmed }, 'live-test');

  // 1. create
  const d1 = await createDraft(env, shell, { editionId: edition.id, by: 'live-test' });
  createdCampaigns.add(d1.campaignId);
  check('create_draft creates a real draft', (await statusOf(d1.campaignId)) === 'save', d1.campaignId);
  check('edition now points at the draft', (await getEdition(env, edition.id)).campaignId === d1.campaignId);

  // 2. re-push
  check('re-pushing without overwrite is refused', (await throws(() => createDraft(env, shell, { editionId: edition.id, by: 'live-test' }))) !== null);
  const d2 = await createDraft(env, shell, { editionId: edition.id, by: 'live-test', overwrite: true });
  check('with overwrite, create_draft reuses the same draft', d2.reusedExistingDraft && d2.campaignId === d1.campaignId);
  const all = await mailchimp(env, 'GET', '/campaigns?count=100&fields=campaigns.id,campaigns.status,campaigns.settings.title');
  check('still exactly one matching draft in Mailchimp', all.campaigns.filter((c) => c.settings.title.startsWith('Live lifecycle test')).length === 1);

  // 3. consent withdrawn -> warning + refusal, draft untouched
  const w = await saveEdition(env, { editionId: edition.id, featured: [{ id: 'f1', founder: 'Test Founder', company: 'Test Co', topic: 'Live lifecycle test', consent: 'none' }] }, 'live-test');
  check('withdrawing consent warns that a draft exists', w.draftWarnings.length === 1 && /delete_draft/.test(w.draftWarnings[0]));
  check('create_draft now refuses (consent gate)', (await throws(() => createDraft(env, shell, { editionId: edition.id, by: 'live-test' }), ConsentError)) !== null);
  check('the existing draft is untouched by the refusal', (await statusOf(d1.campaignId)) === 'save');

  // 4. delete
  const del = await deleteDraft(env, { editionId: edition.id, by: 'live-test' });
  check('delete_draft reports deleted', del.outcome === 'deleted');
  check('the draft is really gone from Mailchimp (404)', (await statusOf(d1.campaignId)) === 'gone');
  const after = await getEdition(env, edition.id);
  check('edition reopened and unlinked, content kept', after.campaignId === null && after.status === 'in_progress' && after.bodyHtml.includes('Lifecycle test body'));
  check('deleting again is an error, not a silent success', (await throws(() => deleteDraft(env, { editionId: edition.id, by: 'live-test' }))) !== null);

  // 5. draft removed behind our back (e.g. deleted in the Mailchimp app)
  await saveEdition(env, { editionId: edition.id, featured: confirmed.map((f, i) => ({ ...f, id: `f${i + 1}` })) }, 'live-test');
  const d3 = await createDraft(env, shell, { editionId: edition.id, by: 'live-test' });
  createdCampaigns.add(d3.campaignId);
  await mailchimp(env, 'DELETE', `/campaigns/${d3.campaignId}`); // simulate deleting it in the Mailchimp app
  const gone = await deleteDraft(env, { editionId: edition.id, by: 'live-test' });
  check('delete_draft copes with a draft already deleted in Mailchimp', gone.outcome === 'already_gone' && (await getEdition(env, edition.id)).campaignId === null);
} catch (err) {
  console.error('\nTest stopped with an error:', err.message);
  results.push(false);
} finally {
  for (const id of createdCampaigns) await mailchimp(env, 'DELETE', `/campaigns/${id}`).catch(() => undefined);
  if (templateId) await mailchimp(env, 'DELETE', `/templates/${templateId}`).catch(() => undefined);
  console.log(`\n${results.filter(Boolean).length}/${results.length} live checks passed. Test campaigns and template cleaned up.`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
