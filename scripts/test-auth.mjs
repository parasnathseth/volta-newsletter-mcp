// Tests for the sign-in boundary: the access rule, ID-token checks, the redirect allowlist,
// and the real consent -> Google -> callback flow (with the OAuth library stubbed).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseIdToken } from '../src/auth/access.ts';
import { isRedirectAllowed, allRedirectsAllowed, checkRegistration, DEFAULT_ALLOWED_REDIRECT_URIS } from '../src/auth/redirects.ts';
import { googleHandler } from '../src/auth/google-handler.ts';
import { checkTestRecipients } from '../src/lib/campaign.ts';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
const future = () => Math.floor(Date.now() / 1000) + 600;
const goodClaims = (over = {}) => ({ iss: 'https://accounts.google.com', aud: 'gid', exp: future(), sub: 'sub-1', email: 'bader@voltaeffect.com', email_verified: true, hd: 'voltaeffect.com', name: 'Bader', ...over });

class FakeKV {
  store = new Map();
  async get(k, type) { const e = this.store.get(k); return e == null ? null : type === 'json' ? JSON.parse(e.value) : e.value; }
  async put(k, v) { this.store.set(k, { value: v }); }
  async delete(k) { this.store.delete(k); }
}

// ---------------------------------------------------------------- access rule
test('access: verified Workspace account on the right domain is allowed', () => {
  assert.equal(isAllowed({ email: 'Bader@VoltaEffect.com', email_verified: true, hd: 'voltaeffect.com', sub: 's' }, { ALLOWED_EMAIL_DOMAIN: 'voltaeffect.com' }), true);
});

test('access: fails closed on every way the domain rule can be faked', () => {
  const env = { ALLOWED_EMAIL_DOMAIN: 'voltaeffect.com' };
  const c = (over) => ({ sub: 's', email: 'a@voltaeffect.com', email_verified: true, hd: 'voltaeffect.com', ...over });
  assert.equal(isAllowed(c({ email_verified: false }), env), false, 'unverified email');
  assert.equal(isAllowed(c({ hd: undefined }), env), false, 'no hosted-domain claim (personal Gmail with a look-alike address)');
  assert.equal(isAllowed(c({ hd: 'evil.com' }), env), false, 'different Workspace');
  assert.equal(isAllowed(c({ email: 'a@evil.com' }), env), false, 'hd matches but the email is elsewhere');
  assert.equal(isAllowed(c({ email: 'a@voltaeffect.com.evil.com', hd: 'voltaeffect.com' }), env), false, 'suffix trick');
  assert.equal(isAllowed(c({ email: 'a@notvoltaeffect.com' }), env), false, 'look-alike domain');
  assert.equal(isAllowed(c({}), {}), false, 'no domain configured means nobody gets in');
  assert.equal(isAllowed(c({}), { ALLOWED_EMAIL_DOMAIN: '  ' }), false, 'blank domain');
});

test('access: the development email list works only when DEV_MODE is "true"', () => {
  const dev = { email: 'me@gmail.com', email_verified: true, sub: 's' };
  const env = { ALLOWED_EMAIL_DOMAIN: 'voltaeffect.com', EXTRA_ALLOWED_EMAILS: 'ME@gmail.com, other@gmail.com' };
  assert.equal(isAllowed(dev, env), false, 'ignored without DEV_MODE even though the secret is still set');
  assert.equal(isAllowed(dev, { ...env, DEV_MODE: 'false' }), false);
  assert.equal(isAllowed(dev, { ...env, DEV_MODE: 'true' }), true);
  assert.equal(isAllowed({ ...dev, email_verified: false }, { ...env, DEV_MODE: 'true' }), false, 'still needs a verified email');
  assert.equal(isAllowed({ ...dev, email: 'x@gmail.com' }, { ...env, DEV_MODE: 'true' }), false, 'exact addresses only');
});

test('test emails: the development list also needs DEV_MODE', () => {
  const env = { EXTRA_ALLOWED_EMAILS: 'me@gmail.com' };
  assert.deepEqual(checkTestRecipients(env, ['me@gmail.com']).rejected, ['me@gmail.com']);
  assert.deepEqual(checkTestRecipients({ ...env, DEV_MODE: 'true' }, ['me@gmail.com']).allowed, ['me@gmail.com']);
  assert.deepEqual(checkTestRecipients(env, ['a@voltaeffect.com']).allowed, ['a@voltaeffect.com']);
});

// ---------------------------------------------------------------- ID token
test('id_token: accepts a good token and rejects each way it can be wrong', () => {
  assert.equal(parseIdToken(jwt(goodClaims()), 'gid').email, 'bader@voltaeffect.com');
  assert.equal(parseIdToken(jwt(goodClaims({ iss: 'accounts.google.com' })), 'gid').sub, 'sub-1');
  assert.throws(() => parseIdToken(jwt(goodClaims({ iss: 'https://evil.example' })), 'gid'), /issuer/);
  assert.throws(() => parseIdToken(jwt(goodClaims({ aud: 'someone-elses-client' })), 'gid'), /audience/);
  assert.throws(() => parseIdToken(jwt(goodClaims({ exp: 1 })), 'gid'), /expired/);
  assert.throws(() => parseIdToken(jwt(goodClaims({ exp: undefined })), 'gid'), /expired/);
  assert.throws(() => parseIdToken(jwt(goodClaims({ email: undefined })), 'gid'), /email/);
  assert.throws(() => parseIdToken('not-a-jwt', 'gid'), /malformed/);
  assert.equal(parseIdToken(jwt(goodClaims({ email_verified: 'true' })), 'gid').email_verified, true);
  assert.equal(parseIdToken(jwt(goodClaims({ email_verified: 'false' })), 'gid').email_verified, false);
});

// ---------------------------------------------------------------- redirect allowlist
test('redirects: only Claude\'s real callback addresses are allowed by default', () => {
  for (const uri of DEFAULT_ALLOWED_REDIRECT_URIS) assert.equal(isRedirectAllowed(uri, {}), true);
  assert.equal(isRedirectAllowed(CLAUDE, {}), true);
  for (const bad of [
    'https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/extra',
    'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback#frag', 'http://localhost:9999/cb', '', 'not a url', undefined, null, 42,
  ]) assert.equal(isRedirectAllowed(bad, {}), false, String(bad));
});

test('redirects: extra exact addresses, and loopback only in DEV_MODE', () => {
  assert.equal(isRedirectAllowed('https://tools.volta.test/cb', { ALLOWED_REDIRECT_URIS: 'https://tools.volta.test/cb' }), true);
  assert.equal(isRedirectAllowed('https://tools.volta.test/other', { ALLOWED_REDIRECT_URIS: 'https://tools.volta.test/cb' }), false);
  assert.equal(isRedirectAllowed('http://localhost:8123/callback', { ALLOWED_REDIRECT_URIS: 'loopback' }), false, 'loopback needs DEV_MODE');
  assert.equal(isRedirectAllowed('http://localhost:8123/callback', { ALLOWED_REDIRECT_URIS: 'loopback', DEV_MODE: 'true' }), true);
  assert.equal(isRedirectAllowed('http://127.0.0.1:8123/callback', { ALLOWED_REDIRECT_URIS: 'loopback', DEV_MODE: 'true' }), true);
  assert.equal(isRedirectAllowed('http://localhost.evil.com/cb', { ALLOWED_REDIRECT_URIS: 'loopback', DEV_MODE: 'true' }), false);
  assert.equal(isRedirectAllowed('https://localhost:8123/cb', { ALLOWED_REDIRECT_URIS: 'loopback', DEV_MODE: 'true' }), false, 'http loopback only');
});

test('registration: rejected unless every redirect address is allowed', () => {
  assert.equal(checkRegistration({ client_name: 'Claude', redirect_uris: [CLAUDE] }, {}), undefined);
  const rejected = checkRegistration({ client_name: 'Claude', redirect_uris: ['https://attacker.example/cb'] }, {});
  assert.equal(rejected.code, 'invalid_redirect_uri');
  assert.equal(rejected.status, 400);
  assert.ok(checkRegistration({ client_name: 'Claude', redirect_uris: [CLAUDE, 'https://attacker.example/cb'] }, {}), 'one bad address is enough to refuse');
  assert.ok(checkRegistration({ client_name: 'Claude' }, {}), 'no redirect addresses at all is refused');
  assert.ok(checkRegistration({ redirect_uris: [] }, {}));
  assert.equal(allRedirectsAllowed('nope', {}), false);
});

// ---------------------------------------------------------------- the real flow
function makeWorld(over = {}) {
  const calls = { complete: [] };
  const clients = { good: { clientName: 'Claude' }, evil: { clientName: 'Claude' } }; // a look-alike is named exactly the same
  const env = {
    OAUTH_KV: new FakeKV(),
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    COOKIE_ENCRYPTION_KEY: 'ck',
    ALLOWED_EMAIL_DOMAIN: 'voltaeffect.com',
    OAUTH_PROVIDER: {
      parseAuthRequest: async (req) => {
        const u = new URL(req.url);
        return { responseType: 'code', clientId: u.searchParams.get('client_id'), redirectUri: u.searchParams.get('redirect_uri'), scope: ['mcp'], state: 'claude-state' };
      },
      lookupClient: async (id) => clients[id] ?? null,
      completeAuthorization: async (o) => { calls.complete.push(o); return { redirectTo: `${o.request.redirectUri}?code=abc&state=claude-state` }; },
    },
    ...over,
  };
  return { env, calls };
}

const cookieHeader = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const origin = 'https://volta.test';
const authorizeUrl = (clientId, redirect = CLAUDE) => `${origin}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&state=claude-state&code_challenge=x&code_challenge_method=S256`;

async function startFlow(env, clientId = 'good', redirect = CLAUDE) {
  const res = await googleHandler.fetch(new Request(authorizeUrl(clientId, redirect)), env);
  const html = await res.text();
  return { res, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1], state: /name="state" value="([^"]+)"/.exec(html)?.[1], cookies: cookieHeader(res) };
}
async function consent(env, s, over = {}) {
  const body = new URLSearchParams({ csrf: over.csrf ?? s.csrf, state: over.state ?? s.state });
  return googleHandler.fetch(new Request(`${origin}/authorize`, { method: 'POST', headers: { cookie: over.cookies ?? s.cookies, 'content-type': 'application/x-www-form-urlencoded' }, body }), env);
}
function stubGoogle(claims, { ok = true } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return ok ? new Response(JSON.stringify({ id_token: jwt(claims) }), { status: 200 }) : new Response('{}', { status: 400 });
    return real(url);
  };
  return () => { globalThis.fetch = real; };
}
async function callback(env, state, cookies) {
  return googleHandler.fetch(new Request(`${origin}/callback?code=gcode&state=${state}`, { headers: { cookie: cookies } }), env);
}
async function fullFlow(env, claims, over = {}) {
  const s = await startFlow(env);
  const post = await consent(env, s);
  const cookies = `${s.cookies}; ${cookieHeader(post)}`.replace(/^; /, '');
  const restore = stubGoogle(claims);
  try { return { s, post, cb: await callback(env, s.state, over.cookies ?? cookies) }; } finally { restore(); }
}

test('flow: consent page names the client, shows where it returns to, and sets a CSRF cookie', async () => {
  const { env } = makeWorld();
  const s = await startFlow(env);
  assert.equal(s.res.status, 200);
  assert.match(s.html, /Claude/);
  assert.match(s.html, /claude\.ai/, 'the redirect host is visible so a look-alike is recognisable');
  assert.ok(s.csrf && s.state);
  assert.match(s.res.headers.get('set-cookie'), /__Host-CSRF=.*HttpOnly.*Secure.*SameSite=Lax/i);
  assert.match(s.res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(s.res.headers.get('x-frame-options'), 'DENY');
});

test('flow: a look-alike client with its own redirect address is refused before anyone signs in', async () => {
  const { env } = makeWorld();
  const s = await startFlow(env, 'evil', 'https://attacker.example/steal');
  assert.equal(s.res.status, 400);
  assert.match(s.html, /not allowed/i);
  assert.ok(!s.html.includes('Continue with Google'), 'no sign-in button is offered');
  assert.equal(env.OAUTH_KV.store.size, 0, 'no state was stored');
  // an unknown client id is also refused
  const unknown = await startFlow(env, 'nobody');
  assert.equal(unknown.res.status, 400);
});

test('flow: the happy path ends in the OAuth library completing authorization for the right user', async () => {
  const { env, calls } = makeWorld();
  const { post, cb } = await fullFlow(env, goodClaims());
  assert.equal(post.status, 302);
  const google = new URL(post.headers.get('location'));
  assert.equal(google.origin + google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(google.searchParams.get('client_id'), 'gid');
  assert.equal(google.searchParams.get('redirect_uri'), `${origin}/callback`);
  assert.equal(google.searchParams.get('scope'), 'openid email profile');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), `${CLAUDE}?code=abc&state=claude-state`);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].props.email, 'bader@voltaeffect.com');
  assert.equal(calls.complete[0].userId, 'sub-1');
});

test('flow: someone outside the domain is turned away and no authorization is completed', async () => {
  for (const claims of [
    goodClaims({ email: 'x@gmail.com', hd: undefined }),
    goodClaims({ hd: 'evil.com', email: 'x@evil.com' }),
    goodClaims({ email_verified: false }),
  ]) {
    const { env, calls } = makeWorld();
    const { cb } = await fullFlow(env, claims);
    assert.equal(cb.status, 403);
    assert.match(await cb.text(), /Access denied/);
    assert.equal(calls.complete.length, 0);
  }
});

test('flow: a Google ID token for a different app (wrong audience) is refused', async () => {
  const { env, calls } = makeWorld();
  const { cb } = await fullFlow(env, goodClaims({ aud: 'another-app' }));
  assert.equal(cb.status, 400);
  assert.equal(calls.complete.length, 0);
});

test('flow: a failed Google exchange is a clean error', async () => {
  const { env } = makeWorld();
  const s = await startFlow(env);
  const post = await consent(env, s);
  const restore = stubGoogle({}, { ok: false });
  try {
    const cb = await callback(env, s.state, `${s.cookies}; ${cookieHeader(post)}`);
    assert.equal(cb.status, 502);
  } finally { restore(); }
});

test('flow: CSRF and state protections', async () => {
  const { env } = makeWorld();
  const s = await startFlow(env);
  assert.equal((await consent(env, s, { csrf: 'forged' })).status, 400, 'wrong CSRF token');
  assert.equal((await consent(env, s, { cookies: '' })).status, 400, 'no CSRF cookie');
  assert.equal((await consent(env, s, { state: 'made-up-state' })).status, 400, 'state that was never issued');

  const post = await consent(env, s);
  const cookies = `${s.cookies}; ${cookieHeader(post)}`;
  const restore = stubGoogle(goodClaims());
  try {
    assert.equal((await callback(env, s.state, s.cookies)).status, 400, 'callback without the browser-bound state cookie');
    assert.equal((await callback(env, 'other-state', cookies)).status, 400, 'callback with a different state');
    assert.equal((await callback(env, s.state, cookies)).status, 302, 'the genuine callback works');
    assert.equal((await callback(env, s.state, cookies)).status, 400, 'a state can be used only once');
  } finally { restore(); }
  assert.equal((await googleHandler.fetch(new Request(`${origin}/callback?error=access_denied`), env)).status, 400, 'Google reported an error');
});

test('flow: a redirect that becomes disallowed between consent and callback is still refused', async () => {
  const { env, calls } = makeWorld();
  const s = await startFlow(env);
  const post = await consent(env, s);
  const stored = JSON.parse(env.OAUTH_KV.store.get(`oauth:state:${s.state}`).value);
  stored.redirectUri = 'https://attacker.example/cb';
  env.OAUTH_KV.store.set(`oauth:state:${s.state}`, { value: JSON.stringify(stored) });
  const restore = stubGoogle(goodClaims());
  try {
    const cb = await callback(env, s.state, `${s.cookies}; ${cookieHeader(post)}`);
    assert.equal(cb.status, 400);
    assert.equal(calls.complete.length, 0);
  } finally { restore(); }
});

test('flow: development email works only with DEV_MODE, end to end', async () => {
  const claims = goodClaims({ email: 'dev@gmail.com', hd: undefined });
  const off = makeWorld({ EXTRA_ALLOWED_EMAILS: 'dev@gmail.com' });
  assert.equal((await fullFlow(off.env, claims)).cb.status, 403);
  const on = makeWorld({ EXTRA_ALLOWED_EMAILS: 'dev@gmail.com', DEV_MODE: 'true' });
  assert.equal((await fullFlow(on.env, claims)).cb.status, 302);
});

test('flow: the landing page and unknown paths reveal nothing sensitive', async () => {
  const { env } = makeWorld();
  const home = await googleHandler.fetch(new Request(`${origin}/`), env);
  assert.equal(home.status, 200);
  assert.doesNotMatch(await home.text(), /gsecret|gid|voltaeffect\.com/);
  assert.equal((await googleHandler.fetch(new Request(`${origin}/admin`), env)).status, 404);
  assert.equal((await googleHandler.fetch(new Request(`${origin}/authorize`, { method: 'PUT' }), env)).status, 404);
});
