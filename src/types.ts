import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // Secrets (wrangler secret put / .dev.vars)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  MAILCHIMP_API_KEY?: string;
  MAILCHIMP_LIST_ID?: string;
  MAILCHIMP_DRY_RUN?: string;

  // Plain vars (wrangler.jsonc) / dev overrides (.dev.vars)
  ALLOWED_EMAIL_DOMAIN?: string;
  EXTRA_ALLOWED_EMAILS?: string; // DEV ONLY, remove at handoff
  TEST_EMAIL_ALLOWED_DOMAINS?: string;
}

// Identity attached to every authenticated MCP request (see completeAuthorization).
export interface UserProps extends Record<string, unknown> {
  email: string;
  name: string;
}
