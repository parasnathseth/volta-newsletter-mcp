// END-TO-END test of every newsletter workflow through the real MCP protocol layer.
//   - Uses the real tool code, real zod input validation, the REAL Volta calendar feed
//     and the REAL Mailchimp sandbox (KV is faked in memory; no Google sign-in needed).
//   - Never sends anything to subscribers or to any inbox: test-email sending runs in
//     dry-run mode. Creates only drafts and a throwaway template, and deletes them.
//   - Never touches the real "Volta Newsletter Shell" template.
// Run: npm run e2e       (needs MAILCHIMP_API_KEY in .dev.vars and network access)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from '../src/server.ts';
import { mailchimp } from '../src/lib/mailchimp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
const skill = readFileSync(join(here, '..', 'skill', 'volta-newsletter', 'brand-and-html.md'), 'utf8');
const key = process.env.MAILCHIMP_API_KEY;
if (!key) { console.error('MAILCHIMP_API_KEY missing (put it in .dev.vars)'); process.exit(1); }

class FakeKV {
  store = new Map();
  async get(k, type) { const e = this.store.get(k); return e == null ? null : type === 'json' ? JSON.parse(e.value) : e.value; }
  async put(k, v, o = {}) { this.store.set(k, { value: v, metadata: o.metadata ?? null }); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.store.get(name).metadata })), list_complete: true }; }
}

const kv = new FakeKV();
const baseEnv = { OAUTH_KV: kv, MAILCHIMP_API_KEY: key, TEST_EMAIL_ALLOWED_DOMAINS: 'voltaeffect.com' };
const liveEnv = { ...baseEnv };
const dryEnv = { ...baseEnv, MAILCHIMP_DRY_RUN: 'true' };
const user = { email: 'e2e@voltaeffect.com', name: 'E2E Test' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const handlerFor = (env) => createMcpHandler(() => createServer(env, shell, () => user), { route: '/mcp' });
const liveHandler = handlerFor(liveEnv);
const dryHandler = handlerFor(dryEnv);

let nextId = 1;
async function rpc(handler, env, method, params) {
  const res = await handler(new Request('https://e2e.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  }), env, ctx);
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  return { status: res.status, body: JSON.parse(dataLine ? dataLine.slice(5) : text) };
}

// Calls a tool and returns { error, text, json }.
async function tool(name, args = {}, { dry = false } = {}) {
  const { body } = await rpc(dry ? dryHandler : liveHandler, dry ? dryEnv : liveEnv, 'tools/call', { name, arguments: args });
  if (body.error) return { error: true, text: body.error.message ?? JSON.stringify(body.error), json: null };
  const text = body.result?.content?.[0]?.text ?? '';
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain-text result */ }
  return { error: !!body.result?.isError, text, json };
}

const results = [];
function check(name, ok, detail = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + String(detail).slice(0, 160) : ''}`); }
const section = (t) => console.log(`\n--- ${t}`);
const campaignStatus = async (id) => { try { return (await mailchimp(liveEnv, 'GET', `/campaigns/${id}?fields=id,status`)).status; } catch (e) { return e.status === 404 ? 'gone' : `error ${e.status}`; } };

const createdCampaigns = new Set();
let templateId = null;

try {
  // ---------------------------------------------------------------- protocol
  section('Protocol and tool catalogue');
  const init = await rpc(liveHandler, liveEnv, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  check('initialize succeeds', init.status === 200 && init.body.result?.serverInfo?.name === 'volta-newsletter');
  const list = await rpc(liveHandler, liveEnv, 'tools/list', {});
  const tools = list.body.result.tools;
  const expected = ['ping', 'whoami', 'get_upcoming_events', 'get_template', 'update_template', 'list_template_versions', 'restore_template', 'save_edition', 'get_edition', 'list_editions', 'render_edition', 'create_draft', 'send_test', 'get_report', 'list_past_campaigns', 'compare_campaigns', 'get_audience_stats', 'delete_draft', 'delete_edition', 'backlog_add', 'backlog_list', 'backlog_update', 'backlog_remove', 'vet_updates', 'do_not_feature_add', 'do_not_feature_list', 'do_not_feature_remove', 'idea_check', 'idea_record', 'idea_list'];
  check('exactly the expected 30 tools are exposed', tools.length === expected.length && expected.every((n) => tools.some((t) => t.name === n)), tools.map((t) => t.name).filter((n) => !expected.includes(n)).join(',') || `${tools.length} tools`);
  check('every tool has a real description and an input schema', tools.every((t) => (t.description ?? '').length > 30 && t.inputSchema?.type === 'object'), tools.filter((t) => (t.description ?? '').length <= 30).map((t) => t.name).join(','));
  check('whoami reports the signed-in user', (await tool('whoami')).text.includes('e2e@voltaeffect.com'));

  section('Input validation through the protocol (bad calls fail cleanly, nothing crashes)');
  check('unknown tool is an error', (await tool('no_such_tool')).error);
  check('wrong parameter type is rejected', (await tool('save_edition', { subject: 12345 })).error);
  check('missing required parameter is rejected', (await tool('backlog_add', {})).error);
  check('invalid enum value is rejected', (await tool('backlog_list', { status: 'bogus' })).error);
  check('too many test recipients is rejected', (await tool('send_test', { to: Array(6).fill('a@voltaeffect.com') }, { dry: true })).error);

  // ---------------------------------------------------------------- events
  section('Events (real Volta calendar feed)');
  const ev = await tool('get_upcoming_events', { includeDescriptions: false });
  check('default window returns a valid result from the real feed', !ev.error && ev.json && Array.isArray(ev.json.events) && ev.json.feed?.source, `${ev.json?.returned} events, source ${ev.json?.feed?.source}`);
  const past = await tool('get_upcoming_events', { from: '2025-11-20', to: '2025-11-30', includeDescriptions: false });
  const sydney = past.json?.events?.find((e) => e.title === 'AI Mixer and Showcase Sydney');
  check('a past window works and shows Halifax-local times', !!sydney && sydney.startLocal === 'Tue, Nov 25, 4:00 PM', sydney?.startLocal);
  check('an invalid date is rejected with guidance', (await tool('get_upcoming_events', { from: 'next tuesday' })).error);
  const cached = await tool('get_upcoming_events', { includeDescriptions: false });
  check('a second call is served from the cache', cached.json?.feed?.source === 'cache', cached.json?.feed?.source);
  const someEvents = (ev.json?.events?.length ? ev.json.events : past.json.events).slice(0, 3);

  // -------------------------------------------------- throwaway Mailchimp template
  const tpl = await mailchimp(liveEnv, 'POST', '/templates', { name: 'zz e2e test shell (auto-deleted)', html: shell });
  templateId = tpl.id;
  await kv.put('template:current', JSON.stringify({ html: shell, mailchimpTemplateId: templateId, updatedAt: 'x', updatedBy: 'e2e', note: 'seed' }));

  // ---------------------------------------------------------------- Skill snippets
  section('Skill building blocks pass the server\'s own validation');
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const blocks = [...skill.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\bF;/g, `font-family:${FONT};`));
  check('the Skill contains its HTML building blocks', blocks.length >= 6, `${blocks.length} blocks`);
  const styleAttrs = blocks.flatMap((b) => [...b.matchAll(/style="([^"]*)"/g)].map((m) => m[1]));
  check('no inline style is cut short by quote-escaping (font stack intact wherever a font is set)', styleAttrs.filter((s) => s.includes('font-family')).every((s) => s.includes('Arial,sans-serif')), `${styleAttrs.length} style attributes`);
  const [paragraph, label, divider, , eventCard, cta] = blocks;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const card = (e) => eventCard.replace('EVENT TITLE', esc(e.title)).replace('STARTLOCAL', esc(e.startLocal)).replace('LOCATION', esc(e.location || 'Volta')).replace('EVENT_URL', e.url || 'https://voltaeffect.com/events');
  const body = [
    paragraph.replace('Text here.', 'Here is what is on at Volta.'),
    label.replace('Founder Spotlight', 'Upcoming at Volta'),
    ...someEvents.map(card),
    divider,
    cta,
  ].join('\n');

  // ---------------------------------------------------------------- editions + consent
  section('Edition and consent workflow');
  const created = await tool('save_edition', {
    label: 'E2E edition',
    subject: 'Volta e2e test',
    previewText: 'Testing the whole workflow',
    windowStart: '2026-10-01',
    windowEnd: '2026-10-31',
    bodyHtml: body,
    featured: [{ founder: 'Jane Doe', company: 'Acme AI', topic: 'Raising a seed round' }],
  });
  check('save_edition accepts a body built from the Skill\'s blocks', !created.error && created.json?.editionId, created.text.slice(0, 120));
  const editionId = created.json?.editionId;
  check('a new featured story starts without consent and warns', created.json?.consentWarnings?.length === 1 && created.json.featured[0].consent === 'none');

  const rendered = await tool('render_edition', { id: editionId });
  check('render_edition returns the finished email HTML', !rendered.error && rendered.json?.html?.includes('Here is what is on at Volta') && rendered.json.html.includes('Halifax') && !rendered.json.html.includes('*|UNSUB|*'));
  check('the preview flags the missing consent', rendered.json?.consentWarnings?.length === 1);

  const blocked = await tool('create_draft', { editionId });
  check('create_draft is refused until consent is confirmed', blocked.error && /not confirmed/.test(blocked.text) && /Jane Doe/.test(blocked.text));
  check('nothing was created in Mailchimp by the refused attempt', (await tool('get_edition', { id: editionId })).json?.campaignId === null);

  const badTest = await tool('send_test', { to: ['someone@gmail.com'], editionId }, { dry: true });
  check('send_test refuses a non-Volta address', badTest.error && /voltaeffect\.com/.test(badTest.text));
  const mixedTest = await tool('send_test', { to: ['ok@voltaeffect.com', 'x@voltaeffect.com.evil.com'], editionId }, { dry: true });
  check('one bad address in a mixed list refuses the whole request', mixedTest.error);
  const okTest = await tool('send_test', { to: ['bader@voltaeffect.com'], editionId }, { dry: true });
  check('send_test works for a Volta address before consent (dry run, nothing sent)', !okTest.error && okTest.json?.dryRun === true);

  const confirmed = await tool('save_edition', { editionId, featured: [{ id: 'f1', founder: 'Jane Doe', company: 'Acme AI', topic: 'Raising a seed round', consent: 'confirmed', consentVia: 'email' }] });
  check('confirming consent (with how it was given) clears the warning', !confirmed.error && confirmed.json?.consentWarnings?.length === 0);
  check('confirming consent without saying how is rejected', (await tool('save_edition', { editionId, featured: [{ id: 'f1', founder: 'Jane Doe', topic: 'Raising a seed round', consent: 'confirmed', consentVia: '' }] })).error);
  check('a rejected consent update changes nothing', (await tool('get_edition', { id: editionId })).json?.featured?.[0]?.consentVia === 'email');
  const topicChange = await tool('save_edition', { editionId, featured: [{ id: 'f1', founder: 'Jane Doe', company: 'Acme AI', topic: 'Hiring their first engineer' }] });
  check('changing a story\'s topic resets its consent and says so', topicChange.json?.consentReset?.length === 1 && topicChange.json.featured[0].consent === 'none' && topicChange.json.consentWarnings.length === 1, topicChange.json?.consentReset?.[0]);
  const reconfirm = await tool('save_edition', { editionId, featured: [{ id: 'f1', founder: 'Jane Doe', company: 'Acme AI', topic: 'Hiring their first engineer', consent: 'confirmed', consentVia: 'email', sourceUrl: 'https://example.com/e2e-source' }] });
  check('consent for the new topic can be recorded explicitly', !reconfirm.error && reconfirm.json?.consentWarnings?.length === 0);

  section('Mailchimp draft workflow (real sandbox)');
  const draft = await tool('create_draft', { editionId });
  check('create_draft creates a real Mailchimp draft', !draft.error && draft.json?.campaignId && /admin\.mailchimp\.com/.test(draft.json?.url ?? ''), draft.text.slice(0, 140));
  const campaignId = draft.json?.campaignId;
  if (campaignId) createdCampaigns.add(campaignId);
  check('the draft really exists in Mailchimp as an unsent draft', (await campaignStatus(campaignId)) === 'save');
  check('Mailchimp\'s send checklist is passed on to the editor', Array.isArray(draft.json?.checklistProblems));
  const compiled = await mailchimp(liveEnv, 'GET', `/campaigns/${campaignId}/content`);
  check('the draft content contains the body inside the template shell', compiled.html.includes('Here is what is on at Volta') && compiled.html.includes('Where builders get built'));

  const changed = await tool('save_edition', { editionId, subject: 'Volta e2e test (revised)' });
  const refusedRepush = await tool('create_draft', { editionId });
  check('re-pushing without overwrite is refused and warns that Mailchimp edits would be lost', refusedRepush.error && /discards any edits made directly in Mailchimp/.test(refusedRepush.text));
  const again = await tool('create_draft', { editionId, overwrite: true });
  check('with overwrite, a second create_draft updates the same draft (no duplicate)', again.json?.reusedExistingDraft === true && again.json.campaignId === campaignId);
  const all = await mailchimp(liveEnv, 'GET', '/campaigns?count=100&fields=campaigns.id,campaigns.settings.title');
  check('exactly one E2E draft exists in Mailchimp', all.campaigns.filter((c) => c.settings.title.startsWith('E2E edition')).length === 1);
  check('the revised subject reached the draft', (await mailchimp(liveEnv, 'GET', `/campaigns/${campaignId}?fields=settings.subject_line`)).settings.subject_line === 'Volta e2e test (revised)');
  void changed;

  const report = await tool('get_report', { editionId });
  check('get_report says the campaign is not sent instead of showing zeros', report.json?.sent === false && report.json.status === 'save', report.text.slice(0, 100));
  const past2 = await tool('list_past_campaigns', { limit: 5, includeContent: true });
  check('list_past_campaigns works against real Mailchimp', !past2.error && Array.isArray(past2.json?.campaigns), `${past2.json?.count} campaigns`);

  section('Analytics (read-only)');
  const cmp = await tool('compare_campaigns', { limit: 6 });
  check('compare_campaigns works against real Mailchimp and lists only sent campaigns', !cmp.error && Array.isArray(cmp.json?.campaigns) && !cmp.json.campaigns.some((c) => c.campaignId === campaignId), `${cmp.json?.count} sent`);
  const aud = await tool('get_audience_stats', { months: 3 });
  check('get_audience_stats returns aggregates and no addresses', !aud.error && typeof aud.json?.subscribers === 'number' && !/@/.test(aud.text), `${aud.json?.subscribers} subscribers`);
  const sentOne = cmp.json?.campaigns?.[0];
  if (sentOne) {
    const rep2 = await tool('get_report', { campaignId: sentOne.campaignId });
    check('get_report on a sent campaign includes Apple-excluded opens, domains, regions and no addresses', rep2.json?.sent === true && rep2.json.opensExcludingApple && Array.isArray(rep2.json.opensByDomain) && Array.isArray(rep2.json.opensByRegion) && !/@/.test(rep2.text), rep2.text.slice(0, 120));
  }

  section('Withdrawing consent after a draft exists');
  const withdrawn = await tool('save_edition', { editionId, featured: [{ id: 'f1', founder: 'Jane Doe', company: 'Acme AI', topic: 'Hiring their first engineer', consent: 'none' }] });
  check('withdrawing consent warns that a Mailchimp draft still exists', withdrawn.json?.mailchimpDraftWarnings?.[0]?.includes('delete_draft'));
  check('create_draft now refuses again', (await tool('create_draft', { editionId })).error);
  check('the existing draft is untouched by the refusal', (await campaignStatus(campaignId)) === 'save');
  check('delete_draft without an editionId is rejected (a delete can never hit "the latest" by accident)', (await tool('delete_draft', {})).error);
  const deleted = await tool('delete_draft', { editionId });
  check('delete_draft removes the draft', !deleted.error && deleted.json?.outcome === 'deleted');
  check('the draft is really gone from Mailchimp', (await campaignStatus(campaignId)) === 'gone');
  const afterDelete = (await tool('get_edition', { id: editionId })).json;
  check('the edition is reopened with its content kept', afterDelete.campaignId === null && afterDelete.status === 'in_progress' && afterDelete.bodyHtml.includes('Here is what is on at Volta'));
  check('deleting again is a clear error', (await tool('delete_draft', { editionId })).error);

  section('Deleting a saved edition');
  const junk = await tool('save_edition', { label: 'E2E throwaway', subject: 'Throwaway', previewText: 'Throwaway', bodyHtml: '<p>Throwaway</p>', featured: [{ founder: 'Temp Person', topic: 'Temp', consent: 'confirmed', consentVia: 'e2e', sourceUrl: 'https://example.com/e2e-source' }] });
  const junkId = junk.json?.editionId;
  check('delete_edition without an editionId is rejected', (await tool('delete_edition', {})).error);
  const junkDraft = await tool('create_draft', { editionId: junkId });
  if (junkDraft.json?.campaignId) createdCampaigns.add(junkDraft.json.campaignId);
  const refusedDelete = await tool('delete_edition', { editionId: junkId });
  check('delete_edition is refused while a Mailchimp draft exists', refusedDelete.error && /delete_draft/.test(refusedDelete.text), refusedDelete.text.slice(0, 100));
  check('the refused edition is still saved', !(await tool('get_edition', { id: junkId })).error);
  await tool('delete_draft', { editionId: junkId });
  const goneEd = await tool('delete_edition', { editionId: junkId });
  check('delete_edition succeeds once the draft is gone and returns what was deleted', !goneEd.error && goneEd.json?.deleted === true && goneEd.json.edition?.label === 'E2E throwaway', goneEd.text.slice(0, 100));
  check('the deleted edition is gone from get_edition and list_editions', (await tool('get_edition', { id: junkId })).error && !(await tool('list_editions')).json?.editions?.some((e) => e.id === junkId));
  check('the other edition is unaffected', !(await tool('get_edition', { id: editionId })).error);

  section('Continuing in a "new chat" and replacing the featured list');
  const latest = await tool('get_edition', {});
  check('get_edition with no id picks the latest draft back up', latest.json?.id === editionId);
  check('list_editions shows it', (await tool('list_editions')).json?.editions?.some((e) => e.id === editionId));
  const replaced = await tool('save_edition', { editionId, featured: [{ founder: 'New Person', topic: 'A launch' }] });
  check('passing featured replaces the whole list (the old story is dropped)', replaced.json?.featured?.length === 1 && replaced.json.featured[0].founder === 'New Person');

  section('Body safety through the protocol');
  check('scripts in a body are rejected', (await tool('save_edition', { editionId, bodyHtml: '<p>x</p><script>alert(1)</script>' })).error);
  check('a full HTML page as the body is rejected', (await tool('save_edition', { editionId, bodyHtml: '<html><body>x</body></html>' })).error);
  check('event-handler attributes are rejected', (await tool('save_edition', { editionId, bodyHtml: '<a onclick="x()">x</a>' })).error);
  check('rejected bodies leave the saved body intact', (await tool('get_edition', { id: editionId })).json.bodyHtml.includes('Here is what is on at Volta'));
  check('harmless prose like "JavaScript:" or "once=" is not rejected', !(await tool('save_edition', { editionId, bodyHtml: '<p>Learn JavaScript: the basics, once=twice.</p>' })).error);
  check('but a javascript: link without spaces or quotes tricks is still rejected', (await tool('save_edition', { editionId, bodyHtml: '<a href=javascript:alert(1)>x</a>' })).error);

  // ---------------------------------------------------------------- template
  section('Template workflow (throwaway template)');
  const t0 = await tool('get_template');
  check('get_template returns the shell with one body region', !t0.error && t0.json?.html?.includes('mc:edit="body"') && t0.json.mailchimpTemplateId === templateId);
  const edited = t0.json.html.replace('Where builders get built.', 'Where builders get built. (e2e)');
  const up = await tool('update_template', { html: edited, note: 'e2e tagline change' });
  check('update_template applies a change and reports the undo id', !up.error && /saved as/.test(up.text), up.text.slice(0, 100));
  check('the change is live in the template', (await tool('get_template')).json.html.includes('(e2e)'));
  const versions = await tool('list_template_versions');
  check('the previous version is listed', versions.json?.count === 1 && /e2e tagline/.test(versions.json.versions[0].note));
  check('a template without the unsubscribe link is refused', (await tool('update_template', { html: edited.replaceAll('*|UNSUB|*', ''), note: 'bad' })).error);
  check('a template with a script is refused', (await tool('update_template', { html: edited + '<script>x</script>', note: 'bad' })).error);
  const undo = await tool('restore_template', { versionId: 'previous' });
  check('restore_template undoes the change', !undo.error && !(await tool('get_template')).json.html.includes('(e2e)'));
  check('an unknown version id is a clear error', (await tool('restore_template', { versionId: 'nope' })).error);

  // ---------------------------------------------------------------- backlog
  section('Founder backlog workflow');
  const add = await tool('backlog_add', { founder: 'Sam Lee', company: 'Beta Labs', note: 'ships a clinical AI tool', links: ['https://beta.example'], revisitDate: '2026-11-01' });
  const sid = add.json?.added?.id;
  check('backlog_add stores an entry', !add.error && sid);
  check('a duplicate is refused immediately and points at the existing entry', (await tool('backlog_add', { founder: 'sam  lee', company: 'BETA LABS' })).text.includes(sid));
  check('an invalid link or date is rejected', (await tool('backlog_add', { founder: 'X', links: ['javascript:1'] })).error && (await tool('backlog_add', { founder: 'X', revisitDate: 'soon' })).error);
  check('backlog_list finds it by dueBy and by search', (await tool('backlog_list', { dueBy: '2026-11-30' })).json.total === 1 && (await tool('backlog_list', { query: 'clinical' })).json.total === 1);
  const upd = await tool('backlog_update', { id: sid, appendNote: 'raised a seed round', featuredInEditionId: editionId });
  check('backlog_update appends a dated note and marks them featured', /\d{4}-\d{2}-\d{2}: raised a seed round/.test(upd.json?.updated?.note ?? '') && upd.json.updated.status === 'featured');
  check('featured people leave the default list', (await tool('backlog_list', {})).json.total === 0);
  const editionBefore = JSON.stringify((await tool('get_edition', { id: editionId })).json);
  const rem = await tool('backlog_remove', { id: sid });
  check('backlog_remove deletes and returns the entry', !rem.error && rem.json?.removed?.founder === 'Sam Lee');
  check('removing again is a clear error', (await tool('backlog_remove', { id: sid })).error);
  check('deleting a backlog entry leaves editions untouched', JSON.stringify((await tool('get_edition', { id: editionId })).json) === editionBefore);
} catch (err) {
  console.error('\nHarness stopped with an error:', err);
  results.push(false);
} finally {
  for (const id of createdCampaigns) await mailchimp(liveEnv, 'DELETE', `/campaigns/${id}`).catch(() => undefined);
  const leftovers = await mailchimp(liveEnv, 'GET', '/campaigns?count=100&fields=campaigns.id,campaigns.settings.title').catch(() => ({ campaigns: [] }));
  for (const c of leftovers.campaigns.filter((x) => x.settings.title.startsWith('E2E edition'))) await mailchimp(liveEnv, 'DELETE', `/campaigns/${c.id}`).catch(() => undefined);
  if (templateId) await mailchimp(liveEnv, 'DELETE', `/templates/${templateId}`).catch(() => undefined);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} end-to-end checks passed. Test drafts and template cleaned up.`);
  process.exitCode = passed === results.length ? 0 : 1;
}
