// Minimal iCalendar (.ics) VEVENT parser built for Workers' 10 ms CPU limit
// (ical.js measured about 9.8 ms per parse of Volta's 182 KB feed; this takes
// about 3 ms). Volta's feed lists every occurrence of a recurring event as its
// own VEVENT with UTC times, so no RRULE expansion is done here. If a VEVENT
// ever carries an RRULE, it is still returned once and flagged
// `hasRecurrence: true` so callers can see the feed changed.

export const EVENT_TIME_ZONE = 'America/Halifax';

export interface IcsEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  url: string | null;
  categories: string[];
  status: string;
  start: string | null; // ISO 8601 UTC
  end: string | null; // ISO 8601 UTC
  allDay: boolean;
  hasRecurrence: boolean;
}

const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// Offset (ms) of `zone` relative to UTC at the given instant.
const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EVENT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function zoneOffsetMs(instant: number): number {
  const parts = Object.fromEntries(offsetFormatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// Wall-clock time in America/Halifax -> UTC ISO string.
function halifaxLocalToIso(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - zoneOffsetMs(guess);
  utc = guess - zoneOffsetMs(utc); // second pass settles DST edges
  return new Date(utc).toISOString();
}

function parseDateValue(value: string): { iso: string | null; allDay: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return { iso: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { iso: halifaxLocalToIso(+y, +mo, +d, 0, 0, 0), allDay: true };
  if (z) return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false };
  // Floating or TZID-qualified time: treated as Halifax local (Volta's zone).
  return { iso: halifaxLocalToIso(+y, +mo, +d, +h, +mi, +s), allDay: false };
}

// Splits "NAME;PARAM=x:value" at the first colon that is not inside quotes.
function splitLine(line: string): { name: string; value: string } | null {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      return { name: line.slice(0, i).split(';')[0].toUpperCase(), value: line.slice(i + 1) };
    }
  }
  return null;
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); // unfold continuation lines
  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  let depth = 0; // ignore nested components (e.g. VALARM) inside a VEVENT

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      depth = 0;
    } else if (cur && line.startsWith('BEGIN:')) {
      depth++;
    } else if (cur && line.startsWith('END:') && line !== 'END:VEVENT') {
      depth--;
    } else if (line === 'END:VEVENT' && cur) {
      const start = parseDateValue(cur.DTSTART ?? '');
      const end = parseDateValue(cur.DTEND ?? '');
      events.push({
        uid: cur.UID ?? '',
        title: unescapeText(cur.SUMMARY ?? '').trim() || '(untitled event)',
        description: unescapeText(cur.DESCRIPTION ?? '').trim(),
        location: unescapeText(cur.LOCATION ?? '').trim(),
        url: cur.URL?.trim() || null,
        categories: (cur.CATEGORIES ?? '').split(',').map((c) => unescapeText(c).trim()).filter(Boolean),
        status: (cur.STATUS ?? 'CONFIRMED').toUpperCase(),
        start: start.iso,
        end: end.iso,
        allDay: start.allDay,
        hasRecurrence: 'RRULE' in cur,
      });
      cur = null;
    } else if (cur && depth === 0) {
      const p = splitLine(line);
      if (p && !(p.name in cur)) cur[p.name] = p.value;
    }
  }
  return events;
}
