import type { Env } from '../types';

export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
}

// Decodes the ID token that Google returned directly from its token endpoint
// over TLS (OIDC permits skipping signature verification in that case) and
// checks issuer, audience and expiry before trusting any claim.
export function parseIdToken(idToken: string, expectedAudience: string): GoogleClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
  const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));

  if (p.iss !== 'https://accounts.google.com' && p.iss !== 'accounts.google.com') throw new Error('bad issuer');
  if (p.aud !== expectedAudience) throw new Error('bad audience');
  if (typeof p.exp !== 'number' || p.exp * 1000 < Date.now()) throw new Error('id_token expired');
  if (typeof p.email !== 'string' || typeof p.sub !== 'string') throw new Error('missing email/sub');

  return {
    sub: p.sub,
    email: p.email,
    email_verified: p.email_verified === true || p.email_verified === 'true',
    hd: typeof p.hd === 'string' ? p.hd : undefined,
    name: typeof p.name === 'string' ? p.name : undefined,
  };
}

// Access rule (fails closed):
//  1. email must be verified by Google, always.
//  2. Workspace path: the `hd` claim must equal ALLOWED_EMAIL_DOMAIN AND the
//     email must end with @<domain> (defence in depth; never the suffix alone).
//  3. DEV ONLY: exact match against EXTRA_ALLOWED_EMAILS (remove at handoff).
export function isAllowed(claims: GoogleClaims, env: Env): boolean {
  if (!claims.email_verified) return false;
  const email = claims.email.toLowerCase();
  const domain = env.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase();

  if (domain && claims.hd?.toLowerCase() === domain && email.endsWith(`@${domain}`)) return true;

  const extras = (env.EXTRA_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return extras.includes(email);
}
