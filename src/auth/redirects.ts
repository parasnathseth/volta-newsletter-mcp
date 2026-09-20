// Which OAuth redirect addresses may receive an authorization code.
//
// Client registration at /register is public (Claude registers itself dynamically), so
// without this an attacker could register a look-alike client named "Claude" with their
// own redirect address, send a Volta employee a sign-in link, and receive a token that
// acts as that employee. Only Claude's real callback addresses are accepted by default.
// The check runs at registration AND at every authorization, so clients registered
// before this rule existed are covered too.

export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export interface RedirectEnv {
  /** Extra exact redirect URIs, comma-separated. The token "loopback" additionally allows http://localhost / 127.0.0.1 on any port, but only when DEV_MODE is "true". */
  ALLOWED_REDIRECT_URIS?: string;
  DEV_MODE?: string;
}

export function isRedirectAllowed(uri: unknown, env: RedirectEnv): boolean {
  if (typeof uri !== 'string') return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;

  const extra = (env.ALLOWED_REDIRECT_URIS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if ([...DEFAULT_ALLOWED_REDIRECT_URIS, ...extra.filter((e) => e !== 'loopback')].includes(uri)) return true;

  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
  return extra.includes('loopback') && env.DEV_MODE === 'true' && url.protocol === 'http:' && loopbackHosts.includes(url.hostname);
}

export function allRedirectsAllowed(uris: unknown, env: RedirectEnv): boolean {
  return Array.isArray(uris) && uris.length > 0 && uris.every((u) => isRedirectAllowed(u, env));
}

/** Used as the OAuth provider's client-registration callback: returns undefined to allow, or a rejection. */
export function checkRegistration(metadata: Record<string, unknown>, env: RedirectEnv): { code: string; description: string; status: number } | undefined {
  if (allRedirectsAllowed(metadata.redirect_uris, env)) return undefined;
  return { code: 'invalid_redirect_uri', description: 'One or more redirect_uris are not allowed for this server.', status: 400 };
}
