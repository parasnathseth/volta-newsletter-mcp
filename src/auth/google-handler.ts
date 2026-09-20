import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import type { Env, UserProps } from '../types';
import { isAllowed, parseIdToken } from './access';
import { logEvent } from '../lib/log';

// Default handler for everything the OAuth provider does not own itself:
// the consent page (/authorize), the Google leg (/callback) and a landing page.
// Flow: Claude -> /authorize (consent page + CSRF) -> Google -> /callback
// (verify email_verified + Workspace domain) -> completeAuthorization.

const STATE_TTL_SECONDS = 600;
const CSRF_COOKIE = '__Host-CSRF';
const STATE_COOKIE = '__Host-OAUTH_STATE';

const enc = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function html(body: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com",
      'X-Frame-Options': 'DENY',
      ...extraHeaders,
    },
  });
}

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a0a;color:#f5f5f7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;padding:32px;border:1px solid #232327;border-radius:12px;background:#111}
h1{font-size:18px;margin:0 0 12px}p{color:#d9d9de;line-height:1.5;font-size:14px}
button{background:#6101ff;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-weight:600;cursor:pointer;font-size:14px}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return html(page('Invalid request', '<h1>Invalid request</h1><p>This sign-in link is not valid.</p>'), 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return html(page('Unknown client', '<h1>Unknown client</h1><p>This app is not registered.</p>'), 400);

  const stateToken = crypto.randomUUID();
  await env.OAUTH_KV.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReq), { expirationTtl: STATE_TTL_SECONDS });

  const csrf = crypto.randomUUID();
  const body = page(
    'Authorize',
    `<h1>Volta Newsletter</h1>
<p><strong>${esc(client.clientName ?? 'An application')}</strong> wants to use the Volta newsletter tools on your behalf. You will sign in with your Volta Google account next.</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="state" value="${stateToken}">
<button type="submit">Continue with Google</button></form>`,
  );
  return html(body, 200, { 'Set-Cookie': setCookie(CSRF_COOKIE, csrf, STATE_TTL_SECONDS) });
}

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const csrf = String(form.get('csrf') ?? '');
  const state = String(form.get('state') ?? '');
  const cookieCsrf = getCookie(request, CSRF_COOKIE);
  if (!csrf || !cookieCsrf || !timingSafeEqual(csrf, cookieCsrf)) {
    return html(page('Blocked', '<h1>Request blocked</h1><p>Security check failed. Go back and try again.</p>'), 400);
  }
  if (!(await env.OAUTH_KV.get(`oauth:state:${state}`))) {
    return html(page('Expired', '<h1>Link expired</h1><p>Please start the connection again from Claude.</p>'), 400);
  }

  const url = new URL(request.url);
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  google.searchParams.set('redirect_uri', `${url.origin}/callback`);
  google.searchParams.set('response_type', 'code');
  google.searchParams.set('scope', 'openid email profile');
  google.searchParams.set('state', state);
  google.searchParams.set('prompt', 'select_account');

  const headers = new Headers({ Location: google.toString() });
  headers.append('Set-Cookie', setCookie(STATE_COOKIE, await sha256Hex(state), STATE_TTL_SECONDS));
  headers.append('Set-Cookie', setCookie(CSRF_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error') || !code || !state) {
    return html(page('Sign-in cancelled', '<h1>Sign-in cancelled</h1><p>Google did not complete the sign-in.</p>'), 400);
  }

  // State must exist in KV (one-time use) AND match the cookie set in this browser.
  const bound = getCookie(request, STATE_COOKIE);
  const stored = await env.OAUTH_KV.get(`oauth:state:${state}`);
  if (!stored || !bound || !timingSafeEqual(bound, await sha256Hex(state))) {
    return html(page('Blocked', '<h1>Request blocked</h1><p>Security check failed. Please start again from Claude.</p>'), 400);
  }
  await env.OAUTH_KV.delete(`oauth:state:${state}`);
  const oauthReq = JSON.parse(stored) as AuthRequest;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    logEvent('auth.google_token_failed', { status: tokenRes.status });
    return html(page('Sign-in failed', '<h1>Sign-in failed</h1><p>Google rejected the request.</p>'), 502);
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return html(page('Sign-in failed', '<h1>Sign-in failed</h1><p>No identity returned.</p>'), 502);

  let claims;
  try {
    claims = parseIdToken(id_token, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    logEvent('auth.bad_id_token', { reason: (e as Error).message });
    return html(page('Sign-in failed', '<h1>Sign-in failed</h1><p>Could not verify your identity.</p>'), 400);
  }

  if (!isAllowed(claims, env)) {
    logEvent('auth.denied', { email: claims.email, verified: claims.email_verified, hd: claims.hd ?? null });
    return html(
      page('Access denied', '<h1>Access denied</h1><p>This tool is limited to Volta accounts. Sign in with your @voltaeffect.com Google account.</p>'),
      403,
    );
  }

  const props: UserProps = { email: claims.email, name: claims.name ?? claims.email };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: claims.sub,
    metadata: { label: props.name },
    scope: oauthReq.scope,
    props,
  });
  logEvent('auth.granted', { email: claims.email });

  const headers = new Headers({ Location: redirectTo });
  headers.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

export const googleHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize' && request.method === 'GET') return handleAuthorizeGet(request, env);
    if (pathname === '/authorize' && request.method === 'POST') return handleAuthorizePost(request, env);
    if (pathname === '/callback' && request.method === 'GET') return handleCallback(request, env);
    if (pathname === '/') return new Response('Volta Newsletter MCP server. Add /mcp as a custom connector in Claude.', { status: 200 });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
