import { mailchimp, type MailchimpEnv } from './mailchimp.ts';

// Read-only analytics. Everything here is an aggregate: no subscriber's address, name or activity is
// ever returned. Groups smaller than MIN_GROUP are merged into "other" so a tiny cell cannot point at one person.
export const MIN_GROUP = 5;
export const SMALL_AUDIENCE = 200;

export interface Group {
  name: string;
  count: number;
}

/** Sorts groups by count and merges any group under `min` into one "Other (small groups)" row. */
export function groupWithFloor(rows: Group[], min = MIN_GROUP, keep = 10): Group[] {
  const sorted = [...rows].filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const big = sorted.filter((r) => r.count >= min).slice(0, keep);
  const otherCount = sorted.filter((r) => !big.includes(r)).reduce((s, r) => s + r.count, 0);
  return otherCount > 0 ? [...big, { name: 'Other (small groups)', count: otherCount }] : big;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : 0);

async function pickListId(env: MailchimpEnv): Promise<string> {
  const lists = await mailchimp<{ lists: { id: string }[] }>(env, 'GET', '/lists?count=20&fields=lists.id');
  if (!lists.lists?.length) throw new Error('The Mailchimp account has no audience.');
  return (env.MAILCHIMP_LIST_ID && lists.lists.find((l) => l.id === env.MAILCHIMP_LIST_ID)?.id) || lists.lists[0].id;
}

// ---- per-campaign extras used by get_report ------------------------------------

export interface ReportExtras {
  opensExcludingApple: { unique: number; rate: number };
  opensByDomain: Group[];
  opensByRegion: Group[];
  unclickedLinks: string[];
}

/** Opens without Apple's automatic downloads, opens by email domain and by region, and links nobody clicked. Failures degrade to empty values. */
export async function reportExtras(env: MailchimpEnv, campaignId: string, report: any, clickedUrls: any[]): Promise<ReportExtras> {
  const [domains, regions] = await Promise.all([
    mailchimp<{ domains?: any[] }>(env, 'GET', `/reports/${campaignId}/domain-performance`).catch(() => ({ domains: [] })),
    mailchimp<{ locations?: any[] }>(env, 'GET', `/reports/${campaignId}/locations?count=50`).catch(() => ({ locations: [] })),
  ]);
  return {
    opensExcludingApple: {
      unique: report.opens?.proxy_excluded_unique_opens ?? 0,
      rate: report.opens?.proxy_excluded_open_rate ?? 0,
    },
    // Domains: recipients who opened, per domain (a domain with fewer than MIN_GROUP openers is merged into "other").
    opensByDomain: groupWithFloor((domains.domains ?? []).map((d) => ({ name: String(d.domain), count: d.opens ?? 0 }))),
    // Regions use the opens Apple did not generate itself, since Apple's automatic downloads show Apple's servers, not the reader.
    opensByRegion: groupWithFloor((regions.locations ?? []).map((l) => ({ name: String(l.region_name || l.country_code || 'Unknown'), count: l.proxy_excluded_opens ?? 0 }))),
    unclickedLinks: clickedUrls.filter((u) => (u.total_clicks ?? 0) === 0).map((u) => String(u.url)).slice(0, 20),
  };
}

// ---- compare_campaigns ---------------------------------------------------------

export interface CampaignRow {
  campaignId: string;
  title: string;
  subject: string;
  sendTime: string | null;
  emailsSent: number;
  openRateExcludingApple: number;
  clickRate: number;
  unsubscribeRate: number;
  bounceRate: number;
}

export interface CompareResult {
  count: number;
  campaigns: CampaignRow[]; // newest first
  latestVsPrevious: { openRateExcludingApple: number; clickRate: number; unsubscribeRate: number } | null; // percentage-point change
  averages: { openRateExcludingApple: number; clickRate: number; unsubscribeRate: number } | null; // across the campaigns listed
  bestByClicks: string | null;
  weakestByClicks: string | null;
  caveats: string[];
}

/** Recent sent campaigns side by side, so a trend (or a standout issue) is easy to see. */
export async function compareCampaigns(env: MailchimpEnv, args: { limit: number }): Promise<CompareResult> {
  const res = await mailchimp<{ reports?: any[] }>(
    env,
    'GET',
    '/reports?count=50&type=regular&fields=reports.id,reports.campaign_title,reports.subject_line,reports.send_time,reports.emails_sent,reports.opens,reports.clicks,reports.unsubscribed,reports.bounces',
  );
  const rows: CampaignRow[] = (res.reports ?? [])
    .filter((r) => (r.emails_sent ?? 0) > 0)
    .map((r) => {
      const sent = r.emails_sent ?? 0;
      return {
        campaignId: r.id,
        title: r.campaign_title ?? '',
        subject: r.subject_line ?? '',
        sendTime: r.send_time || null,
        emailsSent: sent,
        openRateExcludingApple: r.opens?.proxy_excluded_open_rate ?? r.opens?.open_rate ?? 0,
        clickRate: r.clicks?.click_rate ?? 0,
        unsubscribeRate: pct(r.unsubscribed ?? 0, sent),
        bounceRate: pct((r.bounces?.hard_bounces ?? 0) + (r.bounces?.soft_bounces ?? 0), sent),
      };
    })
    .sort((a, b) => Date.parse(b.sendTime ?? '') - Date.parse(a.sendTime ?? ''))
    .slice(0, args.limit);

  const caveats: string[] = [];
  if (!rows.length) return { count: 0, campaigns: [], latestVsPrevious: null, averages: null, bestByClicks: null, weakestByClicks: null, caveats: ['No sent campaigns yet.'] };
  if (rows.length < 3) caveats.push('Fewer than 3 sent campaigns: there is no real trend yet.');
  if (rows.some((r) => r.emailsSent < SMALL_AUDIENCE)) caveats.push(`Some sends went to fewer than ${SMALL_AUDIENCE} people, so a few readers can swing the rates. Treat small differences as noise.`);
  caveats.push('Open rates leave out opens Apple Mail generates automatically. Clicks and unsubscribes are the more reliable signals.');

  const avg = (f: (r: CampaignRow) => number) => Math.round((rows.reduce((s, r) => s + f(r), 0) / rows.length) * 10000) / 10000;
  const delta = (f: (r: CampaignRow) => number) => Math.round((f(rows[0]) - f(rows[1])) * 10000) / 100; // percentage points
  const byClicks = [...rows].sort((a, b) => b.clickRate - a.clickRate);
  return {
    count: rows.length,
    campaigns: rows,
    latestVsPrevious: rows.length >= 2 ? { openRateExcludingApple: delta((r) => r.openRateExcludingApple), clickRate: delta((r) => r.clickRate), unsubscribeRate: delta((r) => r.unsubscribeRate) } : null,
    averages: { openRateExcludingApple: avg((r) => r.openRateExcludingApple), clickRate: avg((r) => r.clickRate), unsubscribeRate: avg((r) => r.unsubscribeRate) },
    bestByClicks: rows.length >= 2 ? byClicks[0].campaignId : null,
    weakestByClicks: rows.length >= 2 ? byClicks[byClicks.length - 1].campaignId : null,
    caveats,
  };
}

// ---- get_audience_stats --------------------------------------------------------

export interface AudienceStats {
  subscribers: number;
  unsubscribedTotal: number;
  cleanedTotal: number;
  unsubscribesSinceLastSend: number;
  newSubscribersSinceLastSend: number;
  growthByMonth: { month: string; subscribed: number; unsubscribed: number; cleaned: number; imported: number; netChange: number }[]; // newest first
  subscribersByCountry: Group[];
  caveats: string[];
}

/** Audience size and growth. Aggregate only. */
export async function getAudienceStats(env: MailchimpEnv, args: { months: number }): Promise<AudienceStats> {
  const listId = await pickListId(env);
  const [list, growth, locations] = await Promise.all([
    mailchimp<{ stats?: any }>(env, 'GET', `/lists/${listId}?fields=stats`),
    mailchimp<{ history?: any[] }>(env, 'GET', `/lists/${listId}/growth-history?count=24`).catch(() => ({ history: [] })),
    mailchimp<{ locations?: any[] }>(env, 'GET', `/lists/${listId}/locations?count=50`).catch(() => ({ locations: [] })),
  ]);
  const s = list.stats ?? {};
  const months = (growth.history ?? [])
    .map((h) => ({
      month: String(h.month),
      subscribed: h.subscribed ?? 0,
      unsubscribed: h.unsubscribed ?? 0,
      cleaned: h.cleaned ?? 0,
      imported: h.imports ?? 0,
      netChange: (h.subscribed ?? 0) - (h.unsubscribed ?? 0) - (h.cleaned ?? 0),
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, args.months);
  const caveats: string[] = [];
  if ((s.member_count ?? 0) < SMALL_AUDIENCE) caveats.push(`The audience has fewer than ${SMALL_AUDIENCE} subscribers, so percentages move a lot on a handful of people.`);
  return {
    subscribers: s.member_count ?? 0,
    unsubscribedTotal: s.unsubscribe_count ?? 0,
    cleanedTotal: s.cleaned_count ?? 0,
    unsubscribesSinceLastSend: s.unsubscribe_count_since_send ?? 0,
    newSubscribersSinceLastSend: s.member_count_since_send ?? 0,
    growthByMonth: months,
    subscribersByCountry: groupWithFloor((locations.locations ?? []).map((l) => ({ name: String(l.country || l.cc || 'Unknown'), count: l.total ?? 0 }))),
    caveats,
  };
}
