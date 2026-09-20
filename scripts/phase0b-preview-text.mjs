// Phase 0b: does settings.preview_text fill the *|MC_PREVIEW_TEXT|* tag, and
// what happens when it is omitted? Also confirms Mailchimp leaves the
// linear-gradient CSS intact in the compiled HTML. NO test email is sent.
// Run from the project root:  node --env-file=.dev.vars scripts/phase0b-preview-text.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.MAILCHIMP_API_KEY;
const dc = apiKey.split('-').pop();
const base = `https://${dc}.api.mailchimp.com/3.0`;
const auth = 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64');

async function mc(method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  return { status: res.status, json };
}

const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
const created = { tpl: null, camps: [] };
try {
  const root = await mc('GET', '/');
  const listId = (await mc('GET', '/lists?count=1')).json.lists[0].id;
  const tpl = await mc('POST', '/templates', { name: `preview-text test ${Date.now()}`, html: shell });
  created.tpl = tpl.json.id;

  async function build(label, previewText) {
    const settings = { subject_line: 'preview test', title: `pt ${label} ${Date.now()}`, from_name: 'Volta (test)', reply_to: root.json.email, template_id: Number(created.tpl) };
    if (previewText !== undefined) settings.preview_text = previewText;
    const c = await mc('POST', '/campaigns', { type: 'regular', recipients: { list_id: listId }, settings });
    created.camps.push(c.json.id);
    await mc('PUT', `/campaigns/${c.json.id}/content`, { template: { id: Number(created.tpl), sections: { body: '<p>body</p>' } } });
    const html = (await mc('GET', `/campaigns/${c.json.id}/content`)).json.html ?? '';
    const stored = (await mc('GET', `/campaigns/${c.json.id}`)).json.settings?.preview_text;
    console.log(`\n[${label}] settings.preview_text stored: ${JSON.stringify(stored)}`);
    console.log(`  literal *|MC_PREVIEW_TEXT|* still in HTML: ${html.includes('*|MC_PREVIEW_TEXT|*')}`);
    console.log(`  contains my preview text: ${previewText ? html.includes(previewText) : 'n/a'}`);
    console.log(`  linear-gradient preserved in HTML: ${html.includes('linear-gradient')}`);
    const m = html.match(/display:none;max-height:0[^>]*>([^<]{0,80})/);
    console.log(`  hidden preheader text: ${m ? JSON.stringify(m[1]) : 'not found'}`);
  }

  await build('with preview_text', 'Test preview text ABC123');
  await build('omitted preview_text', undefined);
  await build('empty-string preview_text', '');
} catch (e) {
  console.error('stopped:', e.message);
} finally {
  for (const id of created.camps) console.log('cleanup campaign', id, (await mc('DELETE', `/campaigns/${id}`)).status);
  if (created.tpl) console.log('cleanup template', created.tpl, (await mc('DELETE', `/templates/${created.tpl}`)).status);
}
