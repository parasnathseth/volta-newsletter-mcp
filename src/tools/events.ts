import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defaultWindow, loadEvents, isValidBound, selectEvents } from '../lib/events.ts';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import type { Env } from '../types.ts';

const BOUND_HELP =
  'Either a date like 2026-10-01 (matched against the event\'s calendar day in Halifax, inclusive) or a full ISO timestamp with offset like 2026-10-01T09:00:00-03:00.';

export function registerEventTools(server: McpServer, env: Env, userEmail: () => string | undefined): void {
  server.registerTool(
    'get_upcoming_events',
    {
      description:
        "Fetch events from Volta's public calendar feed for a date window. Returns exact titles, times (UTC plus a ready-made Halifax-local label), locations and sign-up links, all copied verbatim from the feed. Use these values as-is in the newsletter and never invent or alter event facts. Works for past windows too (set from/to in the past). When a later event with the same title exists, `nextOccurrence` is included so past events can link to the next one. Defaults to the next 30 days.",
      inputSchema: {
        from: z.string().optional().describe(`Window start (inclusive). ${BOUND_HELP} Defaults to today.`),
        to: z.string().optional().describe(`Window end (inclusive). ${BOUND_HELP} Defaults to 14 days (two weeks) after today; set it further out when the editor asks for a longer look ahead.`),
        includeDescriptions: z.boolean().optional().describe('Include the (trimmed) event description. Default true.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum events to return. Default 100.'),
        refresh: z.boolean().optional().describe('Bypass the 1-hour cache and re-download the feed. Default false.'),
      },
    },
    async ({ from, to, includeDescriptions, limit, refresh }) => {
      const now = Date.now();
      const window = defaultWindow(now);
      const fromBound = from ?? window.from;
      const toBound = to ?? window.to;
      for (const [label, v] of [['from', fromBound], ['to', toBound]] as const) {
        if (!isValidBound(v)) {
          return { ...textResult(`Invalid "${label}" value "${v}". ${BOUND_HELP}`), isError: true };
        }
      }

      try {
        const { events, fetchedAt, source } = await loadEvents(env, { refresh, now });
        const result = selectEvents(events, {
          from: fromBound,
          to: toBound,
          now,
          includeDescriptions: includeDescriptions ?? true,
          limit: limit ?? 100,
        });
        logEvent('tool.get_upcoming_events', { user: userEmail(), source, returned: result.events.length });
        return textResult(
          JSON.stringify({
            window: { from: fromBound, to: toBound },
            feed: { fetchedAt, source, note: source === 'stale-cache' ? 'Feed unreachable; showing the last saved copy.' : undefined },
            totalMatching: result.totalMatching,
            returned: result.events.length,
            events: result.events,
          }),
        );
      } catch (err) {
        logEvent('tool.get_upcoming_events.error', { user: userEmail(), message: (err as Error).message });
        return { ...textResult(`Could not load the calendar feed: ${(err as Error).message}`), isError: true };
      }
    },
  );
}
