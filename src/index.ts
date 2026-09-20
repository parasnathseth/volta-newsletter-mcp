import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import { googleHandler } from './auth/google-handler';
import { createServer } from './server.ts';
import bundledShell from '../template/shell.html';
import type { Env, UserProps } from './types';

const currentUser = () => getMcpAuthContext()?.props as UserProps | undefined;

// Everything under /mcp requires a valid OAuth access token; the provider
// rejects unauthenticated calls before this handler runs.
const mcpApi = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    createMcpHandler(() => createServer(env, bundledShell, currentUser), { route: '/mcp' })(request, env, ctx),
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
