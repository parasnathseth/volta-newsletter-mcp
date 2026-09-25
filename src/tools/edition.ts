import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { consentProblems, EditionError, getEdition, listEditions, MAX_BODY_CHARS, MAX_FEATURED, MAX_SOURCE_NOTE, MAX_SOURCE_URL, saveEdition, sourceProblems } from '../lib/edition.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import { checkRateLimit, RateLimitError } from '../lib/rateLimit.ts';
import { renderEdition } from '../lib/render.ts';
import { getTemplateState } from '../lib/template.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });
const errText = (prefix: string, err: unknown) => (err instanceof EditionError ? (err as Error).message : `${prefix}: ${(err as Error).message}`);

// The reminder shown after a save: what is still missing before create_draft will work.
const missingNote = (consentWarnings: string[], sourceWarnings: string[]) => {
  const missing = [consentWarnings.length ? 'confirmed consent' : '', sourceWarnings.length ? 'a source link or source note' : ''].filter(Boolean);
  return missing.length ? `A Mailchimp draft cannot be created until every featured story has ${missing.join(' and ')}.` : undefined;
};

// Upper limits on what one request may carry, so a huge value is refused before any work is done.
const MAX_FIELD = 300; // founder, company, topic, how consent was given
const MAX_NOTE = 1000; // consent note, outcome
const MAX_ID = 64; // ids are 26 characters; this is only an outer bound

const featuredSchema = z.object({
  id: z.string().max(MAX_ID).optional().describe('Existing story id to update; omit to add a new story (an id is assigned).'),
  founder: z.string().max(MAX_FIELD).describe('Founder or person featured.'),
  company: z.string().max(MAX_FIELD).optional().describe('Startup or company.'),
  topic: z.string().max(MAX_FIELD).describe('What this story is about. Consent is tied to this specific story, not to the founder in general.'),
  consent: z.enum(['none', 'requested', 'confirmed']).optional().describe('Consent to share THIS story. Only "confirmed" once the user says the founder agreed.'),
  consentVia: z.string().max(MAX_FIELD).nullable().optional().describe('How consent was given (email, Slack, in person, ...). Required when consent is "confirmed".'),
  consentNote: z.string().max(MAX_NOTE).optional().describe('Optional note, e.g. what exactly was agreed.'),
  outcome: z.string().max(MAX_NOTE).nullable().optional().describe('Filled in later from a founder check-in (did the feature help?).'),
  sourceUrl: z
    .string()
    .max(MAX_SOURCE_URL)
    .nullable()
    .optional()
    .describe('An http(s) link to where the story\'s facts come from (an article, the founder\'s own post, their site). Every featured story needs this OR a sourceNote before a draft can be made. Never invent one. Changing the story\'s topic or founder clears it, so send it again then.'),
  sourceNote: z
    .string()
    .max(MAX_SOURCE_NOTE)
    .nullable()
    .optional()
    .describe('For a story with no public link because the founder told the editor directly (maybe the first time it is shared): one sentence on where it came from, e.g. "Founder emailed the details to Bader on 2026-09-25". Use it instead of sourceUrl, never to hide a missing link. Changing the story\'s topic or founder clears it, so send it again then.'),
});

export function registerEditionTools(server: McpServer, env: Env, bundledShell: string, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'save_edition',
    {
      description:
        'Saves the newsletter edition being worked on so any later chat can pick it up. With no editionId it creates a new edition; with an editionId it updates only the fields you pass (others are kept). bodyHtml is only the newsletter content (an HTML fragment with inline styles) that goes inside the template\'s body region: no <html>/<body>, no scripts, no mc:edit. It must stay in Volta\'s dark brand style: the email is dark, so use only the brand colours (backgrounds #0A0A0A, #0A0A0C, #14101F, #232327, #332A55; text #F5F5F7, #D9D9DE, #A3A3AD, #FFFFFF; accents #05D9E7, #6101FF, #FF6D6D, #FFBB0E) and the Skill\'s building blocks; light backgrounds, dark text and other colours are refused unless the user explicitly asked for a different look (then set allowOffBrand true). Event details in it must come verbatim from get_upcoming_events. List every founder story in `featured` with its own consent status; passing `featured` replaces the whole list. Never set consent to "confirmed" unless the user has told you the founder agreed to this story, and record how in consentVia. Give every featured story a sourceUrl (a link to where its facts come from) or, for a story the founder told the editor directly, a short sourceNote; a draft cannot be created without one of them. Anyone on the do-not-feature list (see do_not_feature_list) cannot be named in a featured story or in the body: the save is refused and nothing is stored, whatever consent says. Returns the edition id and any consent and source-link warnings.',
      inputSchema: {
        editionId: z.string().max(MAX_ID).optional().describe('Omit to create a new edition.'),
        label: z.string().max(200).optional().describe('Free-text name, e.g. "October", "Week 40", "Summer special".'),
        status: z.enum(['in_progress', 'drafted']).optional(),
        windowStart: z.string().max(10).optional().describe('First day of events covered, YYYY-MM-DD.'),
        windowEnd: z.string().max(10).optional().describe('Last day of events covered, YYYY-MM-DD.'),
        subject: z.string().max(150).optional().describe('Email subject line.'),
        previewText: z.string().max(200).optional().describe('Inbox preview text (max 200 characters).'),
        bodyHtml: z.string().max(MAX_BODY_CHARS).optional().describe('The newsletter content as an inline-styled HTML fragment, in the Volta dark brand style (see the Skill building blocks).'),
        allowOffBrand: z.boolean().optional().describe('Leave unset. Set true ONLY when the user explicitly asked for a look outside the Volta dark brand style; otherwise a body with off-brand colours is refused.'),
        featured: z.array(featuredSchema).max(MAX_FEATURED).optional().describe('All founder stories in this edition (replaces the previous list).'),
      },
    },
    async (args) => {
      try {
        await checkRateLimit(env, 'save_edition', user());
        const r = await saveEdition(env, args, user());
        logEvent('tool.save_edition', { user: user(), editionId: r.edition.id, created: r.created, featured: r.edition.featured.length, offBrandAllowed: args.allowOffBrand ? true : undefined });
        return textResult(
          JSON.stringify({
            editionId: r.edition.id,
            created: r.created,
            label: r.edition.label,
            status: r.edition.status,
            featured: r.edition.featured.map((f) => ({ id: f.id, founder: f.founder, topic: f.topic, consent: f.consent, sourceUrl: f.sourceUrl ?? null, sourceNote: f.sourceNote ?? null })),
            consentWarnings: r.consentWarnings,
            sourceWarnings: r.sourceWarnings,
            consentReset: r.consentResets.length ? r.consentResets : undefined,
            mailchimpDraftWarnings: r.draftWarnings.length ? r.draftWarnings : undefined,
            note: missingNote(r.consentWarnings, r.sourceWarnings),
          }),
        );
      } catch (err) {
        logEvent('tool.save_edition.error', { user: user(), message: (err as Error).message });
        return fail(err instanceof RateLimitError ? err.message : errText('Could not save the edition', err));
      }
    },
  );

  server.registerTool(
    'get_edition',
    {
      description: 'Returns a saved edition in full (body, subject, featured stories with consent). With no id, returns the most recently saved edition, which is how to pick a draft back up in a new chat.',
      inputSchema: { id: z.string().max(MAX_ID).optional().describe('Edition id; omit for the most recently saved.') },
    },
    async ({ id }) => {
      try {
        const e = await getEdition(env, id);
        logEvent('tool.get_edition', { user: user(), editionId: e.id });
        // Stories saved before source links or notes existed lack those fields; show them as null so it is clear.
        const featured = e.featured.map((f) => ({ ...f, sourceUrl: f.sourceUrl ?? null, sourceNote: f.sourceNote ?? null }));
        return textResult(JSON.stringify({ ...e, featured, consentWarnings: consentProblems(e), sourceWarnings: sourceProblems(e) }));
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
      inputSchema: { id: z.string().max(MAX_ID).optional().describe('Edition id; omit for the most recently saved.') },
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
            sourceWarnings: sourceProblems(edition),
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
