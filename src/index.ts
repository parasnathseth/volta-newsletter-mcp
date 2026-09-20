import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';
import { googleHandler } from './auth/google-handler';
import { logEvent } from './lib/log';
import { textResult } from './lib/mcp';
import { registerEventTools } from './tools/events.ts';
import { registerTemplateTools } from './tools/template.ts';
import { registerEditionTools } from './tools/edition.ts';
import { registerMailchimpTools } from './tools/mailchimp.ts';
import { registerBacklogTools } from './tools/backlog.ts';
import bundledShell from '../template/shell.html';
import type { Env, UserProps } from './types';

function currentUser(): UserProps | undefined {
  return getMcpAuthContext()?.props as UserProps | undefined;
}

// Scaffold tools. Real tools are added per group in src/tools/ in later phases.
function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'volta-newsletter', version: '0.1.0' });

  server.registerTool(
    'ping',
    {
      description: 'Health check. Returns "pong" plus an optional echoed message.',
      inputSchema: { message: z.string().optional() },
    },
    async ({ message }) => {
      logEvent('tool.ping', { user: currentUser()?.email });
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

  registerEventTools(server, env, () => currentUser()?.email);
  registerTemplateTools(server, env, bundledShell, () => currentUser()?.email);
  registerEditionTools(server, env, bundledShell, () => currentUser()?.email);
  registerMailchimpTools(server, env, bundledShell, () => currentUser()?.email);
  registerBacklogTools(server, env, () => currentUser()?.email);

  return server;
}

// Everything under /mcp requires a valid OAuth access token; the provider
// rejects unauthenticated calls before this handler runs.
const mcpApi = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    createMcpHandler(() => createServer(env), { route: '/mcp' })(request, env, ctx),
} satisfies ExportedHandler<Env>;

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpApi,
  defaultHandler: googleHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 60 * 60, // 1 hour; Claude refreshes silently
  refreshTokenTTL: 90 * 24 * 60 * 60, // 90 days between forced sign-ins
});
