// Probe: what does Mailchimp return for a template, and can the HTML source be read back?
import { readFileSync } from 'node:fs';
const key = process.env.MAILCHIMP_API_KEY;
const base = `https://${key.split('-').pop()}.api.mailchimp.com/3.0`;
const auth = 'Basic ' + Buffer.from('anystring:' + key).toString('base64');
const mc = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = t; } return { status: r.status, json: j }; };
const shell = readFileSync(new URL('../template/shell.html', import.meta.url), 'utf8');
const c = await mc('POST', '/templates', { name: 'probe ' + Date.now(), html: shell });
const id = c.json.id;
console.log('create:', c.status, 'keys:', Object.keys(c.json).join(','));
const g = await mc('GET', `/templates/${id}`);
console.log('GET /templates/{id}:', g.status, 'keys:', Object.keys(g.json).join(','), '| html present:', typeof g.json.html, '| html length:', g.json.html?.length);
const d = await mc('GET', `/templates/${id}/default-content`);
console.log('default-content:', d.status, 'keys:', Object.keys(d.json).join(','), '| sections:', Object.keys(d.json.sections ?? {}));
const p = await mc('PATCH', `/templates/${id}`, { html: shell.replace('Where builders get built.', 'Where builders get built (v2).') });
console.log('PATCH:', p.status, 'keys:', Object.keys(p.json).join(','));
const list = await mc('GET', '/templates?count=100&type=user');
console.log('list user templates:', list.status, list.json.total_items, list.json.templates?.map((t) => `${t.id}:${t.name}`).join(' | '));
console.log('delete:', (await mc('DELETE', `/templates/${id}`)).status);
