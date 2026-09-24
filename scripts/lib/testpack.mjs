// Turns the made-up practice files in fixtures/test-pack/ into the structured input that
// vetUpdates expects. In real use Claude does this step (it reads messy sources and fills
// in the fields); here a small parser plays Claude so the tests and the demo are repeatable
// and need no AI, no account and no network.
//
// The files are DATA. Nothing in them is ever treated as an instruction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEWSLETTER_DATE = '2026-10-05';

const PACK_DIR = fileURLToPath(new URL('../../fixtures/test-pack/', import.meta.url));
const readPack = (name) => readFileSync(join(PACK_DIR, name), 'utf8').replace(/\r\n/g, '\n');

// "- Key: value" lines at the top of each update.
const KEY_LINE = /^- ([A-Za-z]+):\s*(.*)$/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Oct 24" in some text -> "2026-10-24" (using the given year), or null. */
export function dateFromWords(text, year) {
  const m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** The Consent line -> { consent, consentVia, embargoUntil }. No line means no consent field. */
export function parseConsent(line, source) {
  if (!line) return {};
  const yes = line.match(/^yes\b\s*(?:\((.*)\))?\s*$/i);
  if (yes) return { consent: 'yes', consentVia: (yes[1] ?? '').trim() || source };
  if (/^not asked/i.test(line)) return { consent: 'not_asked' };
  const embargo = line.match(/^embargoed until (\d{4}-\d{2}-\d{2})/i);
  if (embargo) return { consent: 'embargoed', embargoUntil: embargo[1], consentVia: source };
  return { consent: 'none' };
}

/** One "## NN" block -> a VetItem. */
export function parseBlock(id, block) {
  const lines = block.split('\n');
  const fields = {};
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  while (i < lines.length) {
    const m = lines[i].match(KEY_LINE);
    if (!m) break;
    fields[m[1].toLowerCase()] = m[2].trim();
    i++;
  }
  const text = lines.slice(i).join('\n').trim();
  const source = fields.source ?? '';
  const item = { id, source, text };

  // What kind of update is it?
  if (fields.event) {
    item.title = fields.event;
    // A recap is about something that already happened: a story, not an upcoming event.
    item.kind = /recap/i.test(fields.event) ? 'founder' : 'event';
  } else if (fields.program) {
    item.kind = 'program';
    item.title = fields.program;
  } else {
    // "Company: none, two students from the AI lab" has no company, only people.
    const company = fields.company ?? '';
    const noCompany = /^none\b/i.test(company);
    if (company && !noCompany) item.company = company;
    if (noCompany) item.person = company.replace(/^none\s*,?\s*/i, '');
    if (fields.person) item.person = fields.person;
    // Someone offering or asking for something (a mentor's free hours, a call for beta testers)
    // is an "ask"; a company's or student's own news is a "founder" story.
    item.kind = fields.person || /asks-and-offers/i.test(source) ? 'ask' : 'founder';
  }

  // The first YYYY-MM-DD on the Date line. For an event that did not come from the events
  // calendar (a partner's email), that date is when the message was sent, so the event's
  // own date is read from the message instead ("now Oct 24 to 25").
  const dateLine = fields.date ?? '';
  const iso = dateLine.match(ISO_DATE)?.[0] ?? null;
  item.date = iso;
  if (item.kind === 'event' && !/calendar/i.test(source)) {
    item.date = dateFromWords(text, (iso ?? NEWSLETTER_DATE).slice(0, 4)) ?? iso;
  }

  item.link = !fields.link || /^none$/i.test(fields.link) ? null : fields.link;
  Object.assign(item, parseConsent(fields.consent, source));
  return item;
}

/** updates.md -> VetItem[] in file order. */
export function parseUpdates(markdown) {
  const parts = markdown.replace(/\r\n/g, '\n').split(/^## (\d+)\s*$/m);
  const items = [];
  // parts = [heading text, id, block, id, block, ...]
  for (let i = 1; i < parts.length; i += 2) items.push(parseBlock(parts[i], parts[i + 1]));
  return items;
}

/** last-newsletter.md -> the date it went out and its items ("- title - link"). */
export function parseLastNewsletter(markdown) {
  const lastIssueDate = markdown.match(/sent (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const lastIssueItems = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- (.+) - (https?:\/\/\S+)\s*$/);
    if (m) lastIssueItems.push({ title: m[1].trim(), link: m[2] });
  }
  return { lastIssueDate, lastIssueItems };
}

/** do-not-feature.md -> [{ name }]. The name is the text before " - ". */
export function parseDoNotFeature(markdown) {
  const names = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- (.+?) - /);
    if (m) names.push({ name: m[1].trim() });
  }
  return names;
}

/** Everything vetUpdates needs, read from the three test-pack files. */
export function loadTestPack() {
  const { lastIssueDate, lastIssueItems } = parseLastNewsletter(readPack('last-newsletter.md'));
  return {
    newsletterDate: NEWSLETTER_DATE,
    lastIssueDate,
    lastIssueItems,
    doNotFeature: parseDoNotFeature(readPack('do-not-feature.md')),
    items: parseUpdates(readPack('updates.md')),
  };
}
