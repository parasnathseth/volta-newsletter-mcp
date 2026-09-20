import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ConsentError, createDraft, deleteDraft, getReport, listPastCampaigns, sendTest } from '../lib/campaign.ts';
import { EditionError } from '../lib/edition.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import { checkRateLimit, RateLimitError } from '../lib/rateLimit.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });
const friendly = (prefix: string, err: unknown) =>
  err instanceof EditionError || err instanceof ConsentError || err instanceof RateLimitError ? (err as Error).message : `${prefix}: ${(err as Error).message}`;

export function registerMailchimpTools(server: McpServer, env: Env, bundledShell: string, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'create_draft',
    {
      description:
        'Creates the Mailchimp DRAFT for a saved edition (never sends anything; the user reviews and sends it from Mailchimp). Uses the saved subject, preview text and body, so save_edition first. Refuses if any featured story lacks confirmed consent, if subject/preview text/body is missing, or if the edition\'s campaign was already sent. If the edition already has a draft, calling again is refused unless overwrite is true, because re-pushing replaces the draft\'s content with the saved edition and discards any edits made directly in Mailchimp: warn the user and get their OK first. Returns a link to open the draft in Mailchimp and Mailchimp\'s own send-readiness checklist problems, which should be shown to the user. Always pass the editionId you are working on: with no editionId it uses the most recently saved edition, which may not be the one you mean.',
      inputSchema: {
        editionId: z.string().optional().describe('Edition id. Always pass it; omitting it uses the most recently saved edition.'),
        overwrite: z.boolean().optional().describe('Set true only after the user agrees to replace the existing Mailchimp draft (discarding edits made in Mailchimp).'),
      },
    },
    async ({ editionId, overwrite }) => {
      try {
        await checkRateLimit(env, 'create_draft', user());
        const r = await createDraft(env, bundledShell, { editionId, by: user(), overwrite });
        logEvent('tool.create_draft', { user: user(), editionId: r.editionId, campaignId: r.campaignId, reused: r.reusedExistingDraft, dryRun: r.dryRun });
        return textResult(JSON.stringify(r));
      } catch (err) {
        logEvent('tool.create_draft.error', { user: user(), blocked: err instanceof ConsentError ? 'consent' : undefined, message: (err as Error).message.slice(0, 200) });
        return fail(friendly('Could not create the draft', err));
      }
    },
  );

  server.registerTool(
    'send_test',
    {
      description:
        'Sends a test email of an edition to up to 5 addresses so the user can see how it really looks in an inbox (more accurate than the artifact preview). Only addresses at the allowed Volta domain (default voltaeffect.com) are accepted; anything else is refused. It does not touch the real draft, works even before founder consent is confirmed, and never reaches the subscriber list. With no editionId it uses the most recently saved edition.',
      inputSchema: {
        to: z.array(z.string()).min(1).max(5).describe('Recipient email addresses (allowed domain only).'),
        editionId: z.string().optional().describe('Edition id; omit for the most recently saved.'),
      },
    },
    async ({ to, editionId }) => {
      try {
        await checkRateLimit(env, 'send_test', user());
        const r = await sendTest(env, bundledShell, { editionId, to });
        logEvent('tool.send_test', { user: user(), editionId: r.editionId, recipients: r.sentTo.length, dryRun: r.dryRun });
        return textResult(JSON.stringify(r));
      } catch (err) {
        logEvent('tool.send_test.error', { user: user(), message: (err as Error).message.slice(0, 200) });
        return fail(friendly('Could not send the test', err));
      }
    },
  );

  server.registerTool(
    'get_report',
    {
      description:
        'Performance of a sent newsletter from Mailchimp: emails sent, opens, clicks, unsubscribes, bounces and the most-clicked links. Give a campaignId, or an editionId (or neither for the most recently saved edition). If the campaign has not been sent (a draft, deleted or scheduled), the result has sent:false and a message instead of numbers. Small numbers are noisy; say so rather than over-interpreting them.',
      inputSchema: {
        campaignId: z.string().optional().describe('Mailchimp campaign id (from list_past_campaigns).'),
        editionId: z.string().optional().describe('Edition id; used to find its campaign.'),
      },
    },
    async ({ campaignId, editionId }) => {
      try {
        const r = await getReport(env, { campaignId, editionId });
        logEvent('tool.get_report', { user: user() });
        return textResult(JSON.stringify(r));
      } catch (err) {
        return fail(friendly('Could not load the report', err));
      }
    },
  );

  server.registerTool(
    'delete_draft',
    {
      description:
        'Deletes the Mailchimp DRAFT that belongs to an edition (for example after consent for a story was withdrawn, or to start over). Destructive: always confirm with the user first. Only unsent drafts can be deleted; a sent or scheduled campaign is refused and must be handled in Mailchimp. The edition itself (body, subject, stories) stays saved and goes back to in progress, so create_draft can make a fresh draft later. The editionId is required so a delete can never hit the wrong edition.',
      inputSchema: { editionId: z.string().describe('The edition whose Mailchimp draft to delete (required).') },
    },
    async ({ editionId }) => {
      try {
        await checkRateLimit(env, 'delete_draft', user());
        const r = await deleteDraft(env, { editionId, by: user() });
        logEvent('tool.delete_draft', { user: user(), editionId: r.editionId, campaignId: r.campaignId, outcome: r.outcome, dryRun: r.dryRun });
        return textResult(JSON.stringify(r));
      } catch (err) {
        logEvent('tool.delete_draft.error', { user: user(), message: (err as Error).message.slice(0, 200) });
        return fail(friendly('Could not delete the draft', err));
      }
    },
  );

  server.registerTool(
    'list_past_campaigns',
    {
      description:
        'Lists recently sent newsletters (newest first) with subject, send time and headline open/click rates. Set includeContent to also get the plain text of the latest three, useful for matching tone and avoiding repeating topics. Use it to compare an edition against previous ones.',
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe('How many campaigns. Default 5.'),
        includeContent: z.boolean().optional().describe('Include plain-text content of the latest 3. Default false.'),
      },
    },
    async ({ limit, includeContent }) => {
      try {
        const campaigns = await listPastCampaigns(env, { limit: limit ?? 5, includeContent: includeContent ?? false });
        logEvent('tool.list_past_campaigns', { user: user(), count: campaigns.length });
        return textResult(JSON.stringify({ count: campaigns.length, campaigns }));
      } catch (err) {
        return fail(friendly('Could not list campaigns', err));
      }
    },
  );
}
