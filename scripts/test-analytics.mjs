// Unit tests for the analytics helpers (compare_campaigns, get_audience_stats, get_report extras). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCampaigns, getAudienceStats, groupWithFloor, reportExtras } from '../src/lib/analytics.ts';

const env = { MAILCHIMP_API_KEY: 'k-us1' };

function install(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace('/3.0', '');
    calls.push(path + u.search);
    for (const [re, body] of routes) {
      if (re.test(path)) {
        if (body === 500) return new Response(JSON.stringify({ title: 'boom', detail: 'x' }), { status: 500 });
        return new Response(JSON.stringify(typeof body === 'function' ? body(u) : body), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ title: 'Unexpected', detail: path }), { status: 500 });
  };
  return calls;
}

const rep = (id, sendTime, sent, openRate, clickRate, unsub = 0, extra = {}) => ({
  id, campaign_title: `T ${id}`, subject_line: `S ${id}`, send_time: sendTime, emails_sent: sent,
  opens: { open_rate: openRate + 0.2, proxy_excluded_open_rate: openRate }, clicks: { click_rate: clickRate },
  unsubscribed: unsub, bounces: { hard_bounces: 0, soft_bounces: 0 }, ...extra,
});

test('groupWithFloor merges groups under 5 into one Other row and keeps the big ones sorted', () => {
  const g = groupWithFloor([{ name: 'a', count: 2 }, { name: 'gmail.com', count: 30 }, { name: 'b', count: 1 }, { name: 'dal.ca', count: 8 }, { name: 'zero', count: 0 }]);
  assert.deepEqual(g, [{ name: 'gmail.com', count: 30 }, { name: 'dal.ca', count: 8 }, { name: 'Other (small groups)', count: 3 }]);
  assert.deepEqual(groupWithFloor([{ name: 'a', count: 4 }]), [{ name: 'Other (small groups)', count: 4 }]);
  assert.deepEqual(groupWithFloor([]), []);
});

test('compare_campaigns sorts newest first, computes changes in percentage points and flags a small audience', async () => {
  install([[/^\/reports$/, { reports: [
    rep('old1', '2026-07-01T00:00:00+00:00', 100, 0.3, 0.02, 1),
    rep('new1', '2026-09-01T00:00:00+00:00', 100, 0.4, 0.05, 0),
    rep('mid1', '2026-08-01T00:00:00+00:00', 100, 0.35, 0.03, 2),
    rep('none', '2026-09-15T00:00:00+00:00', 0, 0, 0),
  ] }]]);
  const r = await compareCampaigns(env, { limit: 6 });
  assert.deepEqual(r.campaigns.map((c) => c.campaignId), ['new1', 'mid1', 'old1'], 'unsent (0 recipients) is dropped, newest first');
  assert.equal(r.latestVsPrevious.openRateExcludingApple, 5); // 0.40 - 0.35
  assert.equal(r.latestVsPrevious.clickRate, 2); // 0.05 - 0.03
  assert.equal(r.campaigns[1].unsubscribeRate, 0.02);
  assert.equal(r.bestByClicks, 'new1');
  assert.equal(r.weakestByClicks, 'old1');
  assert.ok(r.caveats.some((c) => /fewer than 200/.test(c)));
  const limited = await compareCampaigns(env, { limit: 2 });
  assert.equal(limited.count, 2);
});

test('compare_campaigns copes with no sends and with a single send', async () => {
  install([[/^\/reports$/, { reports: [] }]]);
  const none = await compareCampaigns(env, { limit: 6 });
  assert.equal(none.count, 0);
  assert.equal(none.latestVsPrevious, null);
  install([[/^\/reports$/, { reports: [rep('one', '2026-09-01T00:00:00+00:00', 500, 0.4, 0.05)] }]]);
  const one = await compareCampaigns(env, { limit: 6 });
  assert.equal(one.latestVsPrevious, null);
  assert.equal(one.bestByClicks, null);
  assert.ok(one.caveats.some((c) => /Fewer than 3/.test(c)));
});

test('reportExtras returns Apple-excluded opens, grouped domains and regions, unclicked links; a failing endpoint degrades to empty', async () => {
  install([
    [/domain-performance$/, { domains: [{ domain: 'gmail.com', opens: 12 }, { domain: 'dal.ca', opens: 2 }] }],
    [/locations$/, { locations: [{ region_name: 'Nova Scotia', opens: 20, proxy_excluded_opens: 9 }, { region_name: 'California', opens: 30, proxy_excluded_opens: 0 }] }],
  ]);
  const x = await reportExtras(env, 'camp1', { opens: { proxy_excluded_unique_opens: 7, proxy_excluded_open_rate: 0.35 } }, [
    { url: 'https://a', total_clicks: 3 }, { url: 'https://b', total_clicks: 0 },
  ]);
  assert.deepEqual(x.opensExcludingApple, { unique: 7, rate: 0.35 });
  assert.deepEqual(x.opensByDomain, [{ name: 'gmail.com', count: 12 }, { name: 'Other (small groups)', count: 2 }]);
  assert.deepEqual(x.opensByRegion, [{ name: 'Nova Scotia', count: 9 }], 'Apple-only regions show nothing');
  assert.deepEqual(x.unclickedLinks, ['https://b']);

  install([[/domain-performance$/, 500], [/locations$/, 500]]);
  const bad = await reportExtras(env, 'camp1', {}, []);
  assert.deepEqual(bad.opensByDomain, []);
  assert.deepEqual(bad.opensByRegion, []);
});

test('get_audience_stats returns aggregates only, newest month first, and merges tiny country groups', async () => {
  const calls = install([
    [/^\/lists$/, { lists: [{ id: 'L1' }, { id: 'L2' }] }],
    [/^\/lists\/L1$/, { stats: { member_count: 120, unsubscribe_count: 4, cleaned_count: 1, unsubscribe_count_since_send: 2, member_count_since_send: 6 } }],
    [/growth-history$/, { history: [{ month: '2026-07', subscribed: 10, unsubscribed: 1, cleaned: 0, imports: 0 }, { month: '2026-09', subscribed: 8, unsubscribed: 3, cleaned: 1, imports: 0 }, { month: '2026-08', subscribed: 5, unsubscribed: 0, cleaned: 0, imports: 20 }] }],
    [/locations$/, { locations: [{ country: 'Canada', total: 100 }, { country: 'Norway', total: 2 }] }],
  ]);
  const s = await getAudienceStats(env, { months: 2 });
  assert.equal(s.subscribers, 120);
  assert.equal(s.unsubscribesSinceLastSend, 2);
  assert.deepEqual(s.growthByMonth.map((m) => m.month), ['2026-09', '2026-08']);
  assert.equal(s.growthByMonth[0].netChange, 4); // 8 - 3 - 1
  assert.deepEqual(s.subscribersByCountry, [{ name: 'Canada', count: 100 }, { name: 'Other (small groups)', count: 2 }]);
  assert.ok(s.caveats.some((c) => /fewer than 200/.test(c)));
  assert.ok(calls.every((c) => !/members|email-activity|sent-to/.test(c)), 'no per-subscriber endpoint is ever called');
});

test('get_audience_stats uses MAILCHIMP_LIST_ID when set', async () => {
  const calls = install([
    [/^\/lists$/, { lists: [{ id: 'L1' }, { id: 'L2' }] }],
    [/^\/lists\/L2$/, { stats: { member_count: 1000 } }],
    [/growth-history$/, { history: [] }],
    [/locations$/, { locations: [] }],
  ]);
  const s = await getAudienceStats({ ...env, MAILCHIMP_LIST_ID: 'L2' }, { months: 6 });
  assert.equal(s.subscribers, 1000);
  assert.equal(s.caveats.length, 0);
  assert.ok(calls.some((c) => c.startsWith('/lists/L2')));
});
