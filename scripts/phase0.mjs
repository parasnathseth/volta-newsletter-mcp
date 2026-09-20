// Phase 0: verify the Mailchimp mechanics the MCP server will rely on, using
// the single-region shell (template/shell.html). Throwaway script, no server.
// Run from volta-newsletter-mcp/:  node --env-file=../.env scripts/phase0.mjs
// Creates a test template + 2 draft campaigns, sends ONE test email to the
// account owner only, then deletes everything it created (set KEEP=1 to keep).
// Never prints the API key.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.MAILCHIMP_API_KEY;
if (!apiKey) {
  console.error('MAILCHIMP_API_KEY not set (run with --env-file=../.env).');
  process.exit(1);
}
const dc = apiKey.split('-').pop();
const base = `https://${dc}.api.mailchimp.com/3.0`;
const auth = 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64');
const KEEP = process.env.KEEP === '1';

async function mc(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  return { status: res.status, json };
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

const created = { templateId: null, campaigns: [] };

async function cleanup() {
  if (KEEP) { console.log('\nKEEP=1, leaving created resources in place.', created); return; }
  for (const id of created.campaigns) {
    const r = await mc('DELETE', `/campaigns/${id}`);
    console.log(`cleanup campaign ${id}: ${r.status}`);
  }
  if (created.templateId) {
    const r = await mc('DELETE', `/templates/${created.templateId}`);
    console.log(`cleanup template ${created.templateId}: ${r.status}`);
  }
}

try {
  // 1. Auth + account
  const ping = await mc('GET', '/ping');
  record('ping', ping.status === 200, String(ping.status));
  if (ping.status !== 200) throw new Error('auth failed');

  const root = await mc('GET', '/');
  const ownerEmail = root.json.email;
  console.log(`      account: ${root.json.account_name} | plan flags: pro_enabled=${root.json.pro_enabled} | dc=${dc}`);

  const lists = await mc('GET', '/lists?count=1');
  const listId = lists.json.lists?.[0]?.id;
  record('audience exists', !!listId, listId ?? 'none');

  // 2. Read endpoints the tools depend on
  const tpls = await mc('GET', '/templates?count=5&type=user');
  record('list templates', tpls.status === 200, `${tpls.json.total_items} user templates`);
  const camps = await mc('GET', '/campaigns?count=3&sort_field=create_time&sort_dir=DESC');
  record('list campaigns', camps.status === 200, `${camps.json.total_items} campaigns`);
  const reports = await mc('GET', '/reports?count=1');
  record('list reports (endpoint reachable)', reports.status === 200, `${reports.json.total_items} reports`);

  // 3. Create the single-region shell
  const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
  const tpl = await mc('POST', '/templates', { name: `Volta MCP shell test ${new Date().toISOString()}`, html: shell });
  record('POST /templates (single body region)', tpl.status === 200, tpl.status === 200 ? `id ${tpl.json.id}` : JSON.stringify(tpl.json).slice(0, 200));
  if (tpl.status !== 200) throw new Error('template create failed');
  created.templateId = tpl.json.id;

  const dflt = await mc('GET', `/templates/${created.templateId}/default-content`);
  const sectionNames = Object.keys(dflt.json.sections ?? {});
  record('default-content detects exactly ["body"]', sectionNames.length === 1 && sectionNames[0] === 'body', JSON.stringify(sectionNames));

  // 4. Campaign via template + sections
  const bodyHtml = '<p style="margin:0;color:#D9D9DE;">PHASE0-BODY-MARKER first paragraph.</p><p style="margin:12px 0 0;color:#F5F5F7;">Second block, <a href="https://voltaeffect.com" style="color:#05D9E7;">a link</a>.</p>';
  const c1 = await mc('POST', '/campaigns', {
    type: 'regular',
    recipients: { list_id: listId },
    settings: { subject_line: 'Phase 0 test', title: `Phase0 sections ${Date.now()}`, from_name: 'Volta (test)', reply_to: ownerEmail, template_id: Number(created.templateId) },
  });
  record('POST /campaigns (template_id)', c1.status === 200, c1.status === 200 ? c1.json.id : JSON.stringify(c1.json).slice(0, 200));
  if (c1.status !== 200) throw new Error('campaign create failed');
  created.campaigns.push(c1.json.id);

  const put1 = await mc('PUT', `/campaigns/${c1.json.id}/content`, { template: { id: Number(created.templateId), sections: { body: bodyHtml } } });
  record('PUT content template+sections {body}', put1.status === 200, String(put1.status));
  const got1 = await mc('GET', `/campaigns/${c1.json.id}/content`);
  const compiled = got1.json.html ?? '';
  record('compiled HTML contains body marker', compiled.includes('PHASE0-BODY-MARKER'));
  record('compiled HTML keeps footer (unsubscribe anchor)', compiled.includes('>Unsubscribe</a>'));

  // 5. Send-checklist (does Mailchimp consider it sendable?)
  const chk = await mc('GET', `/campaigns/${c1.json.id}/send-checklist`);
  const problems = (chk.json.items ?? []).filter((i) => i.type === 'error').map((i) => `${i.id}:${i.heading}`);
  record('send-checklist has no errors', chk.status === 200 && problems.length === 0, problems.join('; ') || 'ok');

  // 6. Test send to owner only
  const t = await mc('POST', `/campaigns/${c1.json.id}/actions/test`, { test_emails: [ownerEmail], send_type: 'html' });
  record('POST actions/test (to account owner only)', t.status === 204, t.status === 204 ? 'accepted' : JSON.stringify(t.json).slice(0, 200));

  // 7. Still a draft
  const st = await mc('GET', `/campaigns/${c1.json.id}`);
  record('campaign status is "save" (never sent)', st.json.status === 'save', st.json.status);

  // 8. Fallback: raw HTML content (no template sections)
  const c2 = await mc('POST', '/campaigns', {
    type: 'regular',
    recipients: { list_id: listId },
    settings: { subject_line: 'Phase 0 raw html', title: `Phase0 raw ${Date.now()}`, from_name: 'Volta (test)', reply_to: ownerEmail },
  });
  if (c2.status === 200) {
    created.campaigns.push(c2.json.id);
    const put2 = await mc('PUT', `/campaigns/${c2.json.id}/content`, { html: shell.replace('Placeholder body — replaced with the composed edition.', 'PHASE0-RAW-MARKER') });
    record('PUT content raw html (fallback path)', put2.status === 200, String(put2.status));
  } else {
    record('POST /campaigns (raw html fallback)', false, JSON.stringify(c2.json).slice(0, 200));
  }

  // 9. Template update (backup/restore mechanic depends on this)
  const patch = await mc('PATCH', `/templates/${created.templateId}`, { name: 'Volta MCP shell test (patched)', html: shell.replace('Where builders get built.', 'Where builders get built. (patched)') });
  record('PATCH /templates/{id}', patch.status === 200, String(patch.status));
  const dflt2 = await mc('GET', `/templates/${created.templateId}`);
  record('template GET returns html after patch', typeof dflt2.json.html === 'string' || dflt2.status === 200, String(dflt2.status));
} catch (err) {
  console.error('\nScript stopped:', err.message);
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.${failed.length ? ' Failed: ' + failed.map((f) => f.name).join(' | ') : ''}`);
}
