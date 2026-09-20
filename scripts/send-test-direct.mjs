// Sends ONE Mailchimp test email of the current template/shell.html directly to
// TO_EMAIL (no forwarding), with preview_text set, then deletes what it created.
// Run from volta-newsletter-mcp/:
//   TO_EMAIL=someone@example.com node --env-file=.dev.vars scripts/send-test-direct.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.MAILCHIMP_API_KEY;
const to = process.env.TO_EMAIL;
if (!apiKey || !to) { console.error('Need MAILCHIMP_API_KEY and TO_EMAIL'); process.exit(1); }
const base = `https://${apiKey.split('-').pop()}.api.mailchimp.com/3.0`;
const auth = 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64');
async function mc(method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = t; }
  return { status: res.status, json: j };
}
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
const root = await mc('GET', '/');
const listId = (await mc('GET', '/lists?count=1')).json.lists[0].id;
const tpl = await mc('POST', '/templates', { name: `direct test ${Date.now()}`, html: shell });
const c = await mc('POST', '/campaigns', { type: 'regular', recipients: { list_id: listId }, settings: { subject_line: 'Gradient check (direct send)', preview_text: 'Direct Mailchimp test, no forwarding', title: `direct ${Date.now()}`, from_name: 'Volta (test)', reply_to: root.json.email, template_id: Number(tpl.json.id) } });
await mc('PUT', `/campaigns/${c.json.id}/content`, { template: { id: Number(tpl.json.id), sections: { body: '<p style="margin:0;color:#D9D9DE;">Direct test: look at the thin bar at the very top of this email. Rainbow gradient or solid purple?</p>' } } });
const t = await mc('POST', `/campaigns/${c.json.id}/actions/test`, { test_emails: [to], send_type: 'html' });
console.log('test send status:', t.status, t.status === 204 ? '(accepted)' : JSON.stringify(t.json).slice(0, 300));
console.log('cleanup campaign', (await mc('DELETE', `/campaigns/${c.json.id}`)).status, 'template', (await mc('DELETE', `/templates/${tpl.json.id}`)).status);
