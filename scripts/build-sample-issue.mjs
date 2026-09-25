// Builds the sample newsletter from real sources and writes it to sample-issue/.
// Run: node scripts/build-sample-issue.mjs
//
// What it does, in order:
//   1. Pulls Volta's real upcoming events from the live calendar feed.
//   2. Reads sample-issue/sources.json (the blog post, AI news and idea that Claude opened and read).
//   3. Runs every item through the SAME vetting rules the server uses (src/lib/vet.ts).
//   4. Runs the startup idea through the SAME idea check the server uses (src/lib/idea.ts).
//   5. Builds the email body from the Skill's HTML building blocks, checks it with the SAME brand and
//      safety checks save_edition uses, and renders it inside the template.
// Only items the vetting says to FEATURE reach the page. Nothing here sends anything or touches Mailchimp.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvents, selectEvents } from '../src/lib/events.ts';
import { vetUpdates } from '../src/lib/vet.ts';
import { checkIdea } from '../src/lib/idea.ts';
import { renderEdition } from '../src/lib/render.ts';
import { offBrandProblems } from '../src/lib/brand.ts';
import { unsafeHtmlProblems } from '../src/lib/htmlSafety.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (name) => join(root, 'sample-issue', name);
const data = JSON.parse(readFileSync(out('sources.json'), 'utf8'));
const F = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 1. real events from the live calendar feed ------------------------------------------------
// loadEvents wants a KV store for its cache; an empty in-memory one is enough for a one-off run.
const emptyKv = { get: async () => null, put: async () => {}, delete: async () => {} };
const { events } = await loadEvents({ OAUTH_KV: emptyKv }, { refresh: true });
const windowEnd = new Date(Date.parse(`${data.newsletterDate}T12:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
const upcoming = selectEvents(events, { from: data.newsletterDate, to: windowEnd, now: Date.parse(`${data.newsletterDate}T12:00:00Z`), includeDescriptions: false, limit: 50 }).events;
const seenTitles = new Set();
const chosenEvents = upcoming.filter((e) => e.url && !seenTitles.has(e.title) && seenTitles.add(e.title)).slice(0, 6);
const eventItems = chosenEvents.map((e, i) => ({
  id: `event-${i + 1}`,
  kind: 'event',
  source: 'Volta events calendar',
  date: e.date,
  title: e.title,
  link: e.url,
  text: e.title,
}));

// ---- 2 and 3. vet everything -------------------------------------------------------------------
const vet = vetUpdates({
  newsletterDate: data.newsletterDate,
  lastIssueDate: data.lastIssueDate,
  lastIssueItems: [],
  doNotFeature: [], // Volta has not given us a real list yet; the test pack's list is used in the demo.
  items: [...eventItems, ...data.items],
  agentChecks: data.agentChecks,
});
const verdictOf = (id) => vet.results.find((r) => r.id === id);
const featured = (items) => items.filter((it) => verdictOf(it.id)?.verdict === 'feature');
const textOf = (it) => verdictOf(it.id)?.sanitizedText ?? it.text;

// ---- 4. check the idea -------------------------------------------------------------------------
const idea = checkIdea(data.idea, []);
if (!idea.ok) {
  console.error('The idea did not pass the idea check:\n- ' + idea.problems.join('\n- '));
  process.exit(1);
}

// ---- 5. build the body from the Skill's building blocks ----------------------------------------
const label = (t) => `<p style="margin:0 0 6px;${F};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#05D9E7;">${esc(t)}</p>`;
const divider = '<div style="height:1px;background-color:#232327;margin:28px 0;line-height:1px;font-size:0;">&nbsp;</div>';
const paragraph = (t) => `<p style="margin:0 0 14px;${F};font-size:15px;line-height:1.6;color:#D9D9DE;">${esc(t)}</p>`;

const eventCard = (e) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#6101FF" style="background-color:#6101FF;background-image:linear-gradient(180deg,#6101FF,#05D9E7,#FF6D6D,#FFBB0E);border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;">
      <p style="margin:0 0 3px;${F};font-size:15px;font-weight:600;color:#F5F5F7;">${esc(e.title)}</p>
      <p style="margin:0;${F};font-size:13px;color:#A3A3AD;">${esc(e.startLocal)}${e.location ? ` &middot; ${esc(e.location)}` : ''}</p>
      <p style="margin:6px 0 0;"><a href="${esc(e.url)}" style="${F};font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">Sign Up &rarr;</a></p>
    </td>
  </tr>
</table>`;

const infoCard = (headline, detail, url) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#FFBB0E" style="background-color:#FFBB0E;border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;">
      <p style="margin:0 0 3px;${F};font-size:15px;font-weight:600;color:#F5F5F7;">${esc(headline)}</p>
      <p style="margin:0;${F};font-size:13px;line-height:1.5;color:#A3A3AD;">${esc(detail)}</p>
      <p style="margin:6px 0 0;"><a href="${esc(url)}" style="${F};font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">Details &rarr;</a></p>
    </td>
  </tr>
</table>`;

const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const newsCard = (it) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#05D9E7" style="background-color:#05D9E7;border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;">
      <p style="margin:0 0 4px;${F};font-size:15px;font-weight:600;line-height:1.4;color:#F5F5F7;">${esc(it.title)}</p>
      <p style="margin:0 0 8px;${F};font-size:14px;line-height:1.5;color:#D9D9DE;">${esc(textOf(it))}</p>
      <p style="margin:0 0 8px;${F};font-size:13px;line-height:1.5;color:#A3A3AD;"><span style="color:#F5F5F7;font-weight:600;">Why it matters for founders:</span> ${esc(data.whyItMatters[it.id])}</p>
      <p style="margin:0;"><a href="${esc(it.link)}" style="${F};font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">${esc(it.source)} &middot; ${esc(shortDate(it.date))} &rarr;</a></p>
    </td>
  </tr>
</table>`;

const i = data.idea;
const small = (t) => `<p style="margin:0 0 3px;${F};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A3A3AD;">${t}</p>`;
const line = (t, color) => `<p style="margin:0 0 14px;${F};font-size:15px;line-height:1.6;color:${color};">${esc(t)}</p>`;
const evidenceLinks = i.evidence.map((e, n) => `<a href="${esc(e.url)}" style="color:#05D9E7;text-decoration:underline;">${esc(e.note?.split(',')[0] ?? `Source ${n + 1}`)}</a>`).join(' &middot; ');
const ideaCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:14px;">
  <tr>
    <td bgcolor="#0A0A0C" style="padding:22px 24px;background-color:#0A0A0C;">
      <p style="margin:0 0 16px;${F};font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">${esc(i.title)}</p>
      ${small('The idea in one line')}
      ${line(i.pitch, '#F5F5F7')}
      ${small('Who needs it')}
      ${line(i.who, '#D9D9DE')}
      ${small('Why now')}
      ${line(i.whyNow, '#D9D9DE')}
      ${small('Try this in a week')}
      ${line(i.tryThisWeek, '#D9D9DE')}
      <p style="margin:0;${F};font-size:12px;line-height:1.5;color:#A3A3AD;">Sources: ${evidenceLinks}</p>
    </td>
  </tr>
</table>`;

const campaign = `newsletter-${data.newsletterDate}`;
const residencyHref = `https://voltaeffect.com/ai-residency?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=${campaign}`;
const cta = `<div style="background-color:#14101F;border:1px solid #332A55;border-radius:10px;padding:20px 24px;text-align:center;">
  <p style="margin:0 0 16px;${F};font-size:15px;line-height:1.6;color:#F5F5F7;">${esc(i.residencyLine)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
    <td bgcolor="#6101FF" style="border-radius:999px;background-color:#6101FF;background-image:linear-gradient(90deg,#FF6D6D,#FFBB0E 30%,#05D9E7 65%,#6101FF);padding:2px;font-size:0;line-height:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;"><tr>
        <td bgcolor="#0A0A0A" style="border-radius:999px;background-color:#0A0A0A;"><a href="${residencyHref}" style="display:inline-block;padding:14px 36px;${F};font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">Apply Now</a></td>
      </tr></table>
    </td>
  </tr></table>
</div>`;

const comingUp = [
  ...featured(eventItems).map((it) => eventCard(chosenEvents[eventItems.indexOf(it)])),
  ...featured(data.items.filter((it) => it.kind === 'program')).map((it) => infoCard(it.title, `${textOf(it)} Book a free 30-minute call to see if it fits.`, it.link)),
];
const news = featured(data.items.filter((it) => it.kind === 'ai_news')).map(newsCard);

const body = [
  paragraph(data.issue.intro),
  label('Coming up'),
  ...comingUp,
  divider,
  label('The Latest AI News'),
  ...news,
  divider,
  label('A Startup Idea to Think About'),
  ideaCard,
  cta,
].join('\n');

// The same checks save_edition runs, so the sample cannot drift from what the server accepts.
const problems = [...unsafeHtmlProblems(body, 'body'), ...offBrandProblems(body)];
if (problems.length) {
  console.error('The body failed the server checks:\n- ' + problems.join('\n- '));
  process.exit(1);
}

const shell = readFileSync(join(root, 'template', 'shell.html'), 'utf8');
const html = renderEdition(shell, { bodyHtml: body, previewText: data.issue.previewText });
writeFileSync(out('body.html'), body + '\n');
writeFileSync(out('newsletter.html'), html);

// ---- review notes: what went in, what was held or dropped, and why -------------------------------
const nameOf = (id) => [...eventItems, ...data.items].find((it) => it.id === id)?.title ?? id;
const rows = vet.results.map((r) => `| ${nameOf(r.id)} | ${r.verdict.toUpperCase()} | ${r.rule} | ${r.reason.replace(/\|/g, '/')} |`);
const notes = `# Sample issue: review notes

Newsletter date **${data.newsletterDate}**. Subject: **${data.issue.subject}**. Built by \`scripts/build-sample-issue.mjs\` from real sources on 2026-09-24. Nothing was sent and no Mailchimp account was touched.

## What went through the vetting
Server verdicts (the same rules \`vet_updates\` runs) combined with Claude's own double-check (each source was opened and read):

| Item | Verdict | Rule | Reason |
|---|---|---|---|
${rows.join('\n')}

Totals: ${vet.counts.feature} featured, ${vet.counts.hold} held, ${vet.counts.drop} dropped.

## The idea
"${i.title}" passed \`idea_check\` (${idea.wordCount} words, warnings: ${idea.warnings.length ? idea.warnings.join(' ') : 'none'}). It is labelled an idea, not a fact. The evidence is two Volta pages, and the "already exists" check names two real products that need company system data. ${i.agentChecks.found}

## What is deliberately not in this issue
- **Founder stories.** No real founder has agreed to be featured, so the "Volta Community Wins" section is left out rather than filled with anything unconfirmed. The consent gate would hold them.
- **Team highlights** are backlog reference material for Bader and never enter an issue by themselves.
- **OpenAI's latest model announcement.** Search results mentioned it, but the OpenAI page could not be opened (HTTP 403), so it could not be verified and was left out.

## Assumptions
- The last issue date is assumed to be ${data.lastIssueDate}; no real earlier issue was available.
- Volta has not supplied a do-not-feature list, so the real run used an empty one. The demo with the made-up test pack uses a real list.
- Events come from Volta's live calendar feed, limited to the two weeks after the issue date (the default window), one card per recurring title.
`;
writeFileSync(out('review-notes.md'), notes);
console.log(`Built sample-issue/newsletter.html: ${vet.counts.feature} featured, ${vet.counts.hold} held, ${vet.counts.drop} dropped. Events used: ${featured(eventItems).length}.`);
