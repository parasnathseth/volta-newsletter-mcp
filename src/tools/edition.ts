import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { consentProblems, EditionError, getEdition, listEditions, saveEdition } from '../lib/edition.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import { renderEdition } from '../lib/render.ts';
import { getTemplateState } from '../lib/template.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });
const errText = (prefix: string, err: unknown) => (err instanceof EditionError ? (err as Error).message : `${prefix}: ${(err as Error).message}`);

const featuredSchema = z.object({
  id: z.string().optional().describe('Existing story id to update; omit to add a new story (an id is assigned).'),
  founder: z.string().describe('Founder or person featured.'),
  company: z.string().optional().describe('Startup or company.'),
  topic: z.string().describe('What this story is about. Consent is tied to this specific story, not to the founder in general.'),
  consent: z.enum(['none', 'requested', 'confirmed']).optional().describe('Consent to share THIS story. Only "confirmed" once the user says the founder agreed.'),
  consentVia: z.string().nullable().optional().describe('How consent was given (email, Slack, in person, ...). Required when consent is "confirmed".'),
  consentNote: z.string().optional().describe('Optional note, e.g. what exactly was agreed.'),
  outcome: z.string().nullable().optional().describe('Filled in later from a founder check-in (did the feature help?).'),
});

export function registerEditionTools(server: McpServer, env: Env, bundledShell: string, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'save_edition',
    {
      description:
        'Saves the newsletter edition being worked on so any later chat can pick it up. With no editionId it creates a new edition; with an editionId it updates only the fields you pass (others are kept). bodyHtml is only the newsletter content (an HTML fragment with inline styles) that goes inside the template\'s body region: no <html>/<body>, no scripts, no mc:edit. Event details in it must come verbatim from get_upcoming_events. List every founder story in `featured` with its own consent status; passing `featured` replaces the whole list. Never set consent to "confirmed" unless the user has told you the founder agreed to this story, and record how in consentVia. Returns the edition id and any consent warnings.',
      inputSchema: {
        editionId: z.string().optional().describe('Omit to create a new edition.'),
        label: z.string().optional().describe('Free-text name, e.g. "October", "Week 40", "Summer special".'),
        status: z.enum(['in_progress', 'drafted']).optional(),
        windowStart: z.string().optional().describe('First day of events covered, YYYY-MM-DD.'),
        windowEnd: z.string().optional().describe('Last day of events covered, YYYY-MM-DD.'),
        subject: z.string().optional().describe('Email subject line.'),
        previewText: z.string().optional().describe('Inbox preview text (max 200 characters).'),
        bodyHtml: z.string().optional().describe('The newsletter content as an inline-styled HTML fragment.'),
        featured: z.array(featuredSchema).optional().describe('All founder stories in this edition (replaces the previous list).'),
      },
    },
    async (args) => {
      try {
        const r = await saveEdition(env, args, user());
        logEvent('tool.save_edition', { user: user(), editionId: r.edition.id, created: r.created, featured: r.edition.featured.length });
        return textResult(
          JSON.stringify({
            editionId: r.edition.id,
            created: r.created,
            label: r.edition.label,
            status: r.edition.status,
            featured: r.edition.featured.map((f) => ({ id: f.id, founder: f.founder, topic: f.topic, consent: f.consent })),
            consentWarnings: r.consentWarnings,
            mailchimpDraftWarnings: r.draftWarnings.length ? r.draftWarnings : undefined,
            note: r.consentWarnings.length ? 'A Mailchimp draft cannot be created until every featured story has confirmed consent.' : undefined,
          }),
        );
      } catch (err) {
        logEvent('tool.save_edition.error', { user: user(), message: (err as Error).message });
        return fail(errText('Could not save the edition', err));
      }
    },
  );

  server.registerTool(
    'get_edition',
    {
      description: 'Returns a saved edition in full (body, subject, featured stories with consent). With no id, returns the most recently saved edition, which is how to pick a draft back up in a new chat.',
      inputSchema: { id: z.string().optional().describe('Edition id; omit for the most recently saved.') },
    },
    async ({ id }) => {
      try {
        const e = await getEdition(env, id);
        logEvent('tool.get_edition', { user: user(), editionId: e.id });
        return textResult(JSON.stringify({ ...e, consentWarnings: consentProblems(e) }));
      } catch (err) {
        return fail(errText('Could not load the edition', err));
      }
    },
  );

  server.registerTool(
    'list_editions',
    {
      description: 'Lists saved editions, newest first, with status, subject and how many featured stories still lack confirmed consent. Use it to see whether there are drafts in progress.',
      inputSchema: {},
    },
    async () => {
      try {
        const editions = await listEditions(env);
        logEvent('tool.list_editions', { user: user(), count: editions.length });
        return textResult(JSON.stringify({ count: editions.length, editions }));
      } catch (err) {
        return fail(`Could not list editions: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'render_edition',
    {
      description:
        'Returns the finished email HTML for an edition (template shell with the saved body inserted; Mailchimp merge tags replaced by preview stand-ins) so it can be shown as a preview, for example in an HTML artifact. Do not use artifact Share links for unpublished drafts. Artifact previews differ slightly from real email clients, so suggest a test email for an accurate check. With no id, uses the most recently saved edition.',
      inputSchema: { id: z.string().optional().describe('Edition id; omit for the most recently saved.') },
    },
    async ({ id }) => {
      try {
        const [edition, template] = await Promise.all([getEdition(env, id), getTemplateState(env, bundledShell)]);
        if (!edition.bodyHtml.trim()) return fail('This edition has no body yet. Save a bodyHtml first with save_edition.');
        const problems = consentProblems(edition);
        logEvent('tool.render_edition', { user: user(), editionId: edition.id });
        return textResult(
          JSON.stringify({
            editionId: edition.id,
            label: edition.label,
            subject: edition.subject,
            previewText: edition.previewText,
            consentWarnings: problems,
            html: renderEdition(template.html, edition),
          }),
        );
      } catch (err) {
        logEvent('tool.render_edition.error', { user: user(), message: (err as Error).message });
        return fail(errText('Could not render the edition', err));
      }
    },
  );
}
