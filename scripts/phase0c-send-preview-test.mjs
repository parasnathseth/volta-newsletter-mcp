// Sends ONE test email (to the account owner only) with preview_text set, to see
// whether *|MC_PREVIEW_TEXT|* renders in the inbox tile. Cleans up afterwards.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.MAILCHIMP_API_KEY;
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
const tpl = await mc('POST', '/templates', { name: `preview send ${Date.now()}`, html: shell });
const c = await mc('POST', '/campaigns', { type: 'regular', recipients: { list_id: listId }, settings: { subject_line: 'Preview text check', preview_text: 'THIS IS THE PREVIEW TEXT (set via API)', title: `pt send ${Date.now()}`, from_name: 'Volta (test)', reply_to: root.json.email, template_id: Number(tpl.json.id) } });
await mc('PUT', `/campaigns/${c.json.id}/content`, { template: { id: Number(tpl.json.id), sections: { body: '<p style="color:#F5F5F7">Preview text check body.</p>' } } });
const t = await mc('POST', `/campaigns/${c.json.id}/actions/test`, { test_emails: [root.json.email], send_type: 'html' });
console.log('test send:', t.status);
console.log('cleanup campaign', (await mc('DELETE', `/campaigns/${c.json.id}`)).status, 'template', (await mc('DELETE', `/templates/${tpl.json.id}`)).status);
