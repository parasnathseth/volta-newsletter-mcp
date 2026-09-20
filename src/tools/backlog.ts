import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { addEntry, BacklogError, listEntries, removeEntry, updateEntry } from '../lib/backlog.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });
const friendly = (prefix: string, err: unknown) => (err instanceof BacklogError ? err.message : `${prefix}: ${(err as Error).message}`);

const NOT_CONSENT = 'The backlog holds private working notes only. It does not record consent: consent is per story and is recorded on the edition when a story is written.';

export function registerBacklogTools(server: McpServer, env: Env, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'backlog_add',
    {
      description: `Adds someone to the founder backlog: a person or startup worth writing about now or later, with a private note, useful links and an optional date to revisit them. Refuses duplicates (same founder and company) and points to the existing entry. ${NOT_CONSENT}`,
      inputSchema: {
        founder: z.string().describe('Founder or person\'s name.'),
        company: z.string().optional().describe('Startup or company.'),
        note: z.string().optional().describe('Why they are interesting, what to follow up on (max 2000 characters).'),
        links: z.array(z.string()).optional().describe('http(s) links: website, LinkedIn, articles (max 10).'),
        revisitDate: z.string().optional().describe('When to look at them again, YYYY-MM-DD.'),
      },
    },
    async (args) => {
      try {
        const e = await addEntry(env, args, user());
        logEvent('tool.backlog_add', { user: user(), id: e.id });
        return textResult(JSON.stringify({ added: e }));
      } catch (err) {
        return fail(friendly('Could not add to the backlog', err));
      }
    },
  );

  server.registerTool(
    'backlog_list',
    {
      description:
        'Lists founder backlog entries. By default shows entries still waiting to be featured ("idea"), with the soonest revisit dates first. Use dueBy to see who is due for a look by a date, query to search names, companies, notes and links, and status "all" or "featured"/"passed" to see the others.',
      inputSchema: {
        status: z.enum(['idea', 'featured', 'passed', 'all']).optional().describe('Default "idea".'),
        dueBy: z.string().optional().describe('Only entries whose revisit date is on or before this date (YYYY-MM-DD).'),
        query: z.string().optional().describe('Search text.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
      },
    },
    async (args) => {
      try {
        const r = await listEntries(env, args);
        logEvent('tool.backlog_list', { user: user(), returned: r.entries.length });
        return textResult(JSON.stringify({ total: r.total, returned: r.entries.length, entries: r.entries }));
      } catch (err) {
        return fail(friendly('Could not list the backlog', err));
      }
    },
  );

  server.registerTool(
    'backlog_update',
    {
      description:
        'Updates a backlog entry by id. Only the fields you pass change. Use appendNote to add a dated line to the note without losing the old text, note to replace it, revisitDate null to clear the date, status "passed" to shelve someone, and featuredInEditionId to record that they were featured (this also sets status "featured"). To remove an entry entirely use backlog_remove instead.',
      inputSchema: {
        id: z.string().describe('Backlog entry id from backlog_list.'),
        founder: z.string().optional(),
        company: z.string().optional(),
        note: z.string().optional().describe('Replaces the whole note.'),
        appendNote: z.string().optional().describe('Adds a dated line to the existing note.'),
        links: z.array(z.string()).optional().describe('Replaces the links.'),
        revisitDate: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear.'),
        status: z.enum(['idea', 'featured', 'passed']).optional(),
        featuredInEditionId: z.string().optional().describe('Edition id they were featured in.'),
      },
    },
    async (args) => {
      try {
        const e = await updateEntry(env, args, user());
        logEvent('tool.backlog_update', { user: user(), id: e.id });
        return textResult(JSON.stringify({ updated: e }));
      } catch (err) {
        return fail(friendly('Could not update the backlog entry', err));
      }
    },
  );

  server.registerTool(
    'backlog_remove',
    {
      description:
        'Permanently deletes a backlog entry (for example one added by mistake). Destructive and not undoable, so confirm with the user first; if they just want someone off the list for now, use backlog_update with status "passed" instead. Returns the removed entry so it could be re-added. Does not affect any editions.',
      inputSchema: { id: z.string().describe('Backlog entry id from backlog_list.') },
    },
    async ({ id }) => {
      try {
        const removed = await removeEntry(env, id);
        logEvent('tool.backlog_remove', { user: user(), id });
        return textResult(JSON.stringify({ removed, note: 'Deleted. The removed entry is shown so it can be re-added if this was a mistake.' }));
      } catch (err) {
        return fail(friendly('Could not remove the backlog entry', err));
      }
    },
  );
}
