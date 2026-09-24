import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { logEvent } from './lib/log.ts';
import { textResult } from './lib/mcp.ts';
import { registerAnalyticsTools } from './tools/analytics.ts';
import { registerBacklogTools } from './tools/backlog.ts';
import { registerDoNotFeatureTools } from './tools/donotfeature.ts';
import { registerEditionTools } from './tools/edition.ts';
import { registerEventTools } from './tools/events.ts';
import { registerIdeaTools } from './tools/idea.ts';
import { registerMailchimpTools } from './tools/mailchimp.ts';
import { registerTemplateTools } from './tools/template.ts';
import { registerVetTools } from './tools/vet.ts';
import type { Env, UserProps } from './types.ts';

/**
 * Builds the MCP server with every tool. Kept separate from the Worker entry point
 * (which adds OAuth) so tests can drive the real tool layer without a sign-in.
 * `currentUser` returns the signed-in user for the current request, if any.
 */
export function createServer(env: Env, bundledShell: string, currentUser: () => UserProps | undefined): McpServer {
  const server = new McpServer({ name: 'volta-newsletter', version: '0.1.0' });
  const userEmail = () => currentUser()?.email;

  server.registerTool(
    'ping',
    {
      description: 'Health check. Returns "pong" plus an optional echoed message.',
      inputSchema: { message: z.string().optional() },
    },
    async ({ message }) => {
      logEvent('tool.ping', { user: userEmail() });
      return textResult(`pong${message ? `: ${message}` : ''}`);
    },
  );

  server.registerTool(
    'whoami',
    { description: 'Returns the signed-in user this connector is acting as.', inputSchema: {} },
    async () => {
      const user = currentUser();
      logEvent('tool.whoami', { user: user?.email });
      return textResult(user ? `${user.name} <${user.email}>` : 'not authenticated');
    },
  );

  registerEventTools(server, env, userEmail);
  registerTemplateTools(server, env, bundledShell, userEmail);
  registerEditionTools(server, env, bundledShell, userEmail);
  registerMailchimpTools(server, env, bundledShell, userEmail);
  registerBacklogTools(server, env, userEmail);
  registerAnalyticsTools(server, env, userEmail);
  registerVetTools(server, env, userEmail);
  registerDoNotFeatureTools(server, env, userEmail);
  registerIdeaTools(server, env, userEmail);

  return server;
}
