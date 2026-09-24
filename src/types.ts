import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // Secrets (wrangler secret put / .dev.vars)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MAILCHIMP_API_KEY?: string;
  MAILCHIMP_LIST_ID?: string;
  MAILCHIMP_DRY_RUN?: string;

  // Plain vars (wrangler.jsonc) / dev overrides (.dev.vars)
  ALLOWED_EMAIL_DOMAIN?: string;
  TEST_EMAIL_ALLOWED_DOMAINS?: string;
  ALLOWED_REDIRECT_URIS?: string; // extra OAuth redirect URIs beyond Claude's (see src/auth/redirects.ts)
  EDITOR_EMAILS?: string; // comma-separated editor emails (Bader); other signed-in users' backlog entries are marked "team". Unset = everyone is "editor".

  // DEVELOPMENT ONLY. Must be unset in production. EXTRA_ALLOWED_EMAILS is ignored unless DEV_MODE is "true".
  DEV_MODE?: string;
  EXTRA_ALLOWED_EMAILS?: string;
}

// Identity attached to every authenticated MCP request (see completeAuthorization).
export interface UserProps extends Record<string, unknown> {
  email: string;
  name: string;
}
