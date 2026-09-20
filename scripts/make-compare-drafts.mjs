// Creates TWO draft campaigns (never sent) so you can open both in Mailchimp and
// compare the editing experience:
//   A) template + mc:edit body region  (Mailchimp holds a copy of the shell)
//   B) full HTML pushed as the content (no Mailchimp template)
// Leaves them in place; delete them (and the "zz compare test" template) afterwards.
// Run: node --env-file=../.env scripts/make-compare-drafts.mjs
import { readFileSync } from 'node:fs';
const key = process.env.MAILCHIMP_API_KEY;
const dc = key.split('-').pop();
const base = `https://${dc}.api.mailchimp.com/3.0`;
const auth = 'Basic ' + Buffer.from('anystring:' + key).toString('base64');
const mc = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

const shell = readFileSync(new URL('../template/shell.html', import.meta.url), 'utf8');
const P = 'margin:0 0 14px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#D9D9DE;';
const body = `<p style="${P}">Hi everyone, here is what is happening at Volta. This paragraph is plain text you should be able to click into and edit.</p>
<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#05D9E7;">Founder Spotlight</p>
<p style="${P}">Jane Doe of Acme AI just shipped something great. Edit this sentence to test text editing.</p>
<p style="${P}"><a href="https://voltaeffect.com/ai-residency" style="color:#05D9E7;">Apply to the AI Residency</a></p>`;

const root = await mc('GET', '/');
const listId = (await mc('GET', '/lists?count=1')).lists[0].id;
const tpl = await mc('POST', '/templates', { name: 'zz compare test (delete me)', html: shell });

const settings = (title) => ({ subject_line: 'Compare: ' + title, preview_text: 'Editing comparison draft', title: `ZZ compare ${title} ${Date.now()}`, from_name: 'Volta (test)', reply_to: root.email });

// A) template + sections
const a = await mc('POST', '/campaigns', { type: 'regular', recipients: { list_id: listId }, settings: { ...settings('A template'), template_id: Number(tpl.id) } });
await mc('PUT', `/campaigns/${a.id}/content`, { template: { id: Number(tpl.id), sections: { body } } });

// B) full HTML, no template
const merged = shell.replace(/(<div mc:edit="body">)[\s\S]*?(<\/div>\s*<\/td>)/, `$1${body}$2`);
const b = await mc('POST', '/campaigns', { type: 'regular', recipients: { list_id: listId }, settings: settings('B raw html') });
await mc('PUT', `/campaigns/${b.id}/content`, { html: merged });

for (const [label, c] of [['A (template + body region)', a], ['B (raw HTML, no template)', b]]) {
  const cur = await mc('GET', `/campaigns/${c.id}`);
  console.log(`${label}: status=${cur.status} template_id=${cur.settings.template_id ?? 'none'}\n   open: https://${dc}.admin.mailchimp.com/campaigns/edit?id=${c.web_id}`);
}
console.log(`\nComparison template id ${tpl.id} ("zz compare test (delete me)"). Delete both drafts and this template when done.`);
