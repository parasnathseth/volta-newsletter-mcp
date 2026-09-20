// Tests for the HTML safety checks used on newsletter bodies and the template shell.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unsafeHtmlProblems } from '../src/lib/htmlSafety.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, '..', 'template', 'shell.html'), 'utf8');
const skill = readFileSync(join(here, '..', 'skill', 'volta-newsletter', 'SKILL.md'), 'utf8');

const bad = (html, mode = 'body') => unsafeHtmlProblems(html, mode).length > 0;

test('dangerous tags are rejected in newsletter bodies', () => {
  for (const html of [
    '<script>alert(1)</script>', '<script src=x></script>', '<SCRIPT/src=x>', '<iframe src="https://x.example"></iframe>', '<frame src=x>',
    '<object data="x"></object>', '<embed src="x">', '<form action="https://x.example"><input name=a></form>', '<input type="text">',
    '<button>Go</button>', '<textarea></textarea>', '<select><option>a</option></select>', '<base href="https://x.example/">',
    '<link rel="stylesheet" href="https://x.example/a.css">', '<svg onload=alert(1)></svg>', '<math><mi>x</mi></math>',
    '<style>p{color:red}</style>', '<meta charset="utf-8">', '<meta http-equiv="refresh" content="0;url=https://x.example">',
  ]) assert.ok(bad(html), html);
});

test('event-handler attributes are rejected however they are written', () => {
  for (const html of ['<a onclick="x()">x</a>', '<a href="x"onclick="y()">x</a>', '<div\nonmouseover="y()">x</div>', '<img src="https://x.example/a.png" ONERROR="y()">', '<a href=x/onfocus=y()>x</a>']) {
    assert.ok(bad(html), html);
  }
});

test('URLs must use https, http, mailto or tel, however they are obfuscated', () => {
  for (const html of [
    '<a href="javascript:alert(1)">x</a>', '<a href=" JavaScript:alert(1)">x</a>', '<a href=javascript:alert(1)>x</a>', "<a href='javascript:alert(1)'>x</a>",
    '<a href="jav&#x61;script:alert(1)">x</a>', '<a href="jav&#97script:alert(1)">x</a>', '<a href="java&Tab;script:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>', '<a href="java\nscript:alert(1)">x</a>', '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>', '<a href="​javascript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<img src="data:image/png;base64,AAAA">',
    '<a href="ftp://x.example/file">x</a>', '<a href="file:///etc/passwd">x</a>', '<a href="blob:https://x.example/1">x</a>',
    '<td background="javascript:alert(1)">x</td>', '<a xlink:href="javascript:alert(1)">x</a>',
  ]) assert.ok(bad(html), JSON.stringify(html));
});

test('active or external CSS is rejected', () => {
  for (const html of [
    '<p style="width:expression(alert(1))">x</p>', '<p style="background:url(javascript:alert(1))">x</p>', '<p style="background:url(\'data:image/png;base64,AA\')">x</p>',
    '<p style="behavior:url(x.htc)">x</p>', '<p style="-moz-binding:url(x)">x</p>', '<p style="@import url(x)">x</p>',
  ]) assert.ok(bad(html), html);
});

test('ordinary email content is accepted', () => {
  for (const html of [
    '<p style="margin:0;color:#D9D9DE;">Hello &amp; welcome.</p>',
    '<a href="https://voltaeffect.com/ai-residency" style="color:#05D9E7;">Apply</a>',
    '<a href="http://example.com/a?b=c&amp;d=e">x</a>', '<a href="mailto:hello@voltaeffect.com">Email us</a>', '<a href="tel:+19025551234">Call</a>',
    '<a href="/events">relative</a>', '<a href="#top">anchor</a>', '<a href="*|UNSUB|*">Unsubscribe</a>', '<a href="*|ARCHIVE|*">View</a>',
    '<img src="https://voltaeffect.com/logo.png" alt="Volta" width="120">',
    '<table role="presentation" width="100%"><tr><td bgcolor="#0A0A0C" style="background-image:linear-gradient(90deg,#6101FF,#05D9E7);">x</td></tr></table>',
    '<p>Learn JavaScript: the basics, and what we did once=twice at the meetup.</p>',
    '<p>The word &lt;script&gt; and &lt;iframe&gt; written as text are fine.</p>',
    '<p>Working with onboarding=process and ion= values, plus javascript-tips and expression of interest.</p>',
    '<a href="https://example.com/javascript:tips">looks scary but is a path</a>',
  ]) assert.deepEqual(unsafeHtmlProblems(html), [], html);
});

test('the Skill\'s own building blocks pass the body checks', () => {
  const blocks = [...skill.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 6);
  for (const b of blocks) assert.deepEqual(unsafeHtmlProblems(b), [], b.slice(0, 80));
});

test('the template shell passes in template mode but not as a body (it uses head tags on purpose)', () => {
  assert.deepEqual(unsafeHtmlProblems(shell, 'template'), []);
  assert.ok(bad(shell, 'body'));
});

test('template mode still rejects active content', () => {
  for (const extra of ['<script>x</script>', '<iframe src=x></iframe>', '<form></form>', '<link rel=stylesheet href=x>', '<meta http-equiv="refresh" content="0;url=x">', '<a href="javascript:x()">x</a>', '<a onclick="x()">x</a>', '<a href="data:text/html,x">x</a>']) {
    assert.ok(bad(shell + extra, 'template'), extra);
  }
});

test('markup hidden in Outlook conditional comments is scanned too', () => {
  assert.ok(bad('<!--[if mso]><script>alert(1)</script><![endif]-->'));
  assert.ok(bad('<!--[if mso]><a href="javascript:alert(1)">x</a><![endif]-->'));
  assert.ok(bad('<!--[if mso]><iframe src=x></iframe><![endif]-->', 'template'));
});

test('problems are reported once each, with plain-language messages', () => {
  const problems = unsafeHtmlProblems('<script></script><script></script><a href="javascript:a()">x</a><a href="javascript:b()">y</a>');
  assert.equal(problems.filter((p) => /Script tags/.test(p)).length, 1);
  assert.equal(problems.filter((p) => /javascript: links/.test(p)).length, 1);
  assert.match(unsafeHtmlProblems('<iframe src=x></iframe>')[0], /iframe.*not allowed/);
  assert.match(unsafeHtmlProblems('<a href="ftp://x">x</a>')[0], /https, http, mailto or tel/);
});
