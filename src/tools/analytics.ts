import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { compareCampaigns, getAudienceStats } from '../lib/analytics.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });

export function registerAnalyticsTools(server: McpServer, env: Env, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'compare_campaigns',
    {
      description:
        'Recent SENT newsletters side by side (newest first): recipients, open rate (leaving out opens Apple Mail generates automatically), click rate, unsubscribe rate and bounce rate, plus the change from the previous send, the averages, and which issue had the most and fewest clicks. Use it to see whether the newsletter is improving, which issues stood out and what those issues did differently (compare their subjects, and use get_report and list_past_campaigns with includeContent for the content). Read the caveats in the result: small audiences make small differences noise, and clicks and unsubscribes are more trustworthy than opens. Drafts and unsent campaigns are never included. Aggregate numbers only; no individual subscribers.',
      inputSchema: { limit: z.number().int().min(2).max(12).optional().describe('How many recent sends to compare. Default 6.') },
    },
    async ({ limit }) => {
      try {
        const r = await compareCampaigns(env, { limit: limit ?? 6 });
        logEvent('tool.compare_campaigns', { user: user(), count: r.count });
        return textResult(JSON.stringify(r));
      } catch (err) {
        return fail(`Could not compare campaigns: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_audience_stats',
    {
      description:
        'The size and health of the Mailchimp audience: subscribers, total unsubscribes and cleaned addresses, month-by-month growth (new subscribers, unsubscribes, net change), changes since the last send, and subscribers by country. Use it to answer whether the list is growing and whether a send cost subscribers. Aggregate numbers only: no names or email addresses are returned, and groups under 5 people are merged into "Other". Small audiences make percentages jumpy; say so.',
      inputSchema: { months: z.number().int().min(1).max(24).optional().describe('How many months of growth history. Default 6.') },
    },
    async ({ months }) => {
      try {
        const r = await getAudienceStats(env, { months: months ?? 6 });
        logEvent('tool.get_audience_stats', { user: user() });
        return textResult(JSON.stringify(r));
      } catch (err) {
        return fail(`Could not load audience stats: ${(err as Error).message}`);
      }
    },
  );
}
