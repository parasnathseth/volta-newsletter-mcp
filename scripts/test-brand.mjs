// Tests for the brand-colour check that keeps newsletter bodies on Volta's dark style. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { offBrandProblems } from '../src/lib/brand.ts';
import { saveEdition, EditionError } from '../src/lib/edition.ts';

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, '..', 'skill', 'volta-newsletter', 'brand-and-html.md'), 'utf8');
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const blocks = [...skill.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\bF;/g, `font-family:${FONT};`));

class FakeKV {
  store = new Map();
  async get(k, type) { const e = this.store.get(k); return e ? (type === 'json' ? JSON.parse(e.value) : e.value) : null; }
  async put(k, v, o = {}) { this.store.set(k, { value: v, metadata: o.metadata ?? null }); }
  async delete(k) { this.store.delete(k); }
  async list() { return { keys: [], list_complete: true }; }
}

test('every HTML building block in the Skill passes the brand check (the Skill cannot drift from the check)', () => {
  assert.ok(blocks.length >= 9, `found ${blocks.length} blocks`);
  for (const [i, b] of blocks.entries()) assert.deepEqual(offBrandProblems(b), [], `block ${i} should be on brand`);
});

test('brand-coloured text, links, comments, entities and fonts are not flagged', () => {
  const ok = [
    '<p style="color:#F5F5F7;">Hi</p>',
    '<p style="COLOR:#f5f5f7">lowercase is fine</p>',
    '<a href="#top" style="color:#05D9E7;">Top</a> &#39;quoted&#39; and &amp; more',
    "<p style=\"font-family:'Arial Black',Arial;color:#D9D9DE;\">Font names that look like colours are fine</p>",
    '<!-- <p style="color:red">commented out</p> --><p>Plain</p>',
    '<td bgcolor="#FFBB0E" style="background-color:#FFBB0E;color:#0A0A0A;">Dark text on an amber accent is readable</td>',
    '<p style="color:inherit;background-color:transparent;border:1px solid #232327;">keywords</p>',
    '<td style="background-image:linear-gradient(90deg,#6101FF,#05D9E7,#FF6D6D,#FFBB0E);">gradient in brand colours</td>',
    '<p style="color:#fff;">short white hex</p>',
    '<img src="https://example.com/a.png" alt="x" style="border:0;">',
  ];
  for (const html of ok) assert.deepEqual(offBrandProblems(html), [], html);
});

test('the drift seen with a weaker model is caught: light tiles, dark text, blue tiles, gold accent', () => {
  const cases = [
    ['<div style="background-color:#FFFFFF;">light tile</div>', /Light backgrounds/],
    ['<td bgcolor="#F5F5F7">light tile via bgcolor</td>', /Light backgrounds/],
    ['<div style="background:#ffffff;">shorthand</div>', /Light backgrounds/],
    ['<p style="color:#0A0A0A;">dark text on the dark email</p>', /Dark text/],
    ['<p style="color:#232327;">dark grey text</p>', /Dark text/],
    ['<div style="background-color:#2563EB;">blue tile</div>', /not Volta brand colours: #2563EB/],
    ['<div style="border-left:4px solid #D4AF37;">gold accent</div>', /#D4AF37/],
    ['<div style="background-color:#EEF2FF;">pale blue</div>', /#EEF2FF/],
    ['<p style="color:black;">named</p>', /Colour names/],
    ['<div style="background:white;">named</div>', /Colour names/],
    ['<p style="color:rgb(0,0,0);">function</p>', /Colour functions/],
    ['<p style="color:hsl(200 50% 50%);">function</p>', /Colour functions/],
    ['<font color="#333333">old attribute</font>', /#333333/],
    ['<td bgcolor="#eee">short hex</td>', /#EEEEEE/],
    ["<p style='color:#111;'>single-quoted style</p>", /#111111/],
  ];
  for (const [html, re] of cases) {
    const p = offBrandProblems(html).join(' ');
    assert.match(p, re, html);
  }
});

test('save_edition refuses an off-brand body with guidance, and accepts it only with allowOffBrand', async () => {
  const env = { OAUTH_KV: new FakeKV() };
  const bad = '<div style="background-color:#FFFFFF;color:#111111;">light card</div>';
  await assert.rejects(saveEdition(env, { label: 'x', bodyHtml: bad }, 'u'), (e) => e instanceof EditionError && /dark brand style/.test(e.message) && /allowOffBrand/.test(e.message) && /#0A0A0A/.test(e.message));
  const ok = await saveEdition(env, { label: 'x', bodyHtml: bad, allowOffBrand: true }, 'u');
  assert.equal(ok.edition.bodyHtml, bad);
  const onBrand = await saveEdition(env, { label: 'y', bodyHtml: '<p style="color:#F5F5F7;">fine</p>' }, 'u');
  assert.equal(onBrand.created, true);
});

test('saving other fields never re-checks an existing body (only a new bodyHtml is checked)', async () => {
  const env = { OAUTH_KV: new FakeKV() };
  const e = (await saveEdition(env, { label: 'x', bodyHtml: '<div style="background-color:#FFFFFF;">x</div>', allowOffBrand: true }, 'u')).edition;
  const again = await saveEdition(env, { editionId: e.id, subject: 'New subject' }, 'u');
  assert.equal(again.edition.subject, 'New subject');
});
