// Checks that a deployment is configured for PRODUCTION use, so a maintainer does not have
// to remember every item in HANDOFF.md. Read-only: it lists secret NAMES (never values),
// reads wrangler.jsonc, and makes a few harmless requests to the live Worker.
//
// Run:  npm run handoff:check -- https://your-worker.workers.dev
// Needs `npx wrangler login` on the account that owns the Worker.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const url = (process.argv[2] ?? process.env.WORKER_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(url)) {
  console.error('Usage: npm run handoff:check -- https://<your-worker>.workers.dev');
  process.exit(2);
}

const results = [];
const check = (level, name, ok, detail = '') => {
  results.push({ level, ok });
  console.log(`${ok ? 'PASS' : level === 'warn' ? 'WARN' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// ---- configuration in the repo
const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const vars = wrangler.vars ?? {};
console.log('\nConfiguration (wrangler.jsonc)');
check('fail', 'ALLOWED_EMAIL_DOMAIN is set', !!vars.ALLOWED_EMAIL_DOMAIN, vars.ALLOWED_EMAIL_DOMAIN);
check('fail', 'TEST_EMAIL_ALLOWED_DOMAINS is set', !!vars.TEST_EMAIL_ALLOWED_DOMAINS, vars.TEST_EMAIL_ALLOWED_DOMAINS);
check('fail', 'MAILCHIMP_DRY_RUN is not "true"', vars.MAILCHIMP_DRY_RUN !== 'true');
check('fail', 'DEV_MODE is not set in wrangler.jsonc', vars.DEV_MODE === undefined);
check('warn', 'ALLOWED_REDIRECT_URIS adds nothing beyond Claude\'s addresses', !vars.ALLOWED_REDIRECT_URIS, vars.ALLOWED_REDIRECT_URIS);

// ---- secrets on the deployed Worker (names only)
console.log('\nSecrets on the deployed Worker (names only)');
const secrets = spawnSync('npx wrangler secret list', { cwd: root, encoding: 'utf8', shell: true });
let names = [];
try {
  const json = secrets.stdout.slice(secrets.stdout.indexOf('['));
  names = JSON.parse(json).map((s) => s.name);
} catch {
  check('fail', 'could read the secret list (run `npx wrangler login` first)', false, (secrets.stderr || secrets.stdout).trim().split('\n').pop());
}
if (names.length) {
  for (const required of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MAILCHIMP_API_KEY']) check('fail', `${required} is set`, names.includes(required));
  check('fail', 'DEV_MODE secret is NOT set (it enables the development sign-in bypass)', !names.includes('DEV_MODE'));
  check('fail', 'EXTRA_ALLOWED_EMAILS secret is NOT set (development only)', !names.includes('EXTRA_ALLOWED_EMAILS'));
  check('fail', 'MAILCHIMP_DRY_RUN secret is NOT set', !names.includes('MAILCHIMP_DRY_RUN'));
}

// ---- the live Worker
console.log(`\nLive Worker (${url})`);
const get = (path, init) => fetch(url + path, { redirect: 'manual', ...init });
try {
  const mcp = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('fail', '/mcp refuses requests without a sign-in (HTTP 401)', mcp.status === 401, `HTTP ${mcp.status}`);

  const meta = await get('/.well-known/oauth-authorization-server');
  const doc = meta.ok ? await meta.json() : {};
  check('fail', 'OAuth discovery document is served', !!doc.authorization_endpoint && doc.authorization_endpoint.startsWith(url), doc.authorization_endpoint);

  const evil = await get('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://attacker.example/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  check('fail', 'a look-alike client with its own redirect address cannot register (HTTP 400)', evil.status === 400, `HTTP ${evil.status}`);

  const localhost = await get('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  check('fail', 'a localhost client cannot register (HTTP 400)', localhost.status === 400, `HTTP ${localhost.status}`);

  const home = await get('/');
  const homeText = await home.text();
  check('warn', 'the landing page reveals no configuration', home.status === 200 && !/voltaeffect\.com|client_id|secret/i.test(homeText));
} catch (err) {
  check('fail', 'the Worker could be reached', false, err.message);
}

const failed = results.filter((r) => !r.ok && r.level === 'fail').length;
const warned = results.filter((r) => !r.ok && r.level === 'warn').length;
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed, ${failed} failed, ${warned} warnings.`);
console.log(failed ? 'NOT ready for production: fix the FAIL lines above (see HANDOFF.md).' : 'No blocking problems found. Still work through the manual items in HANDOFF.md (Google Internal project, Mailchimp key rotation, ownership).');
process.exitCode = failed ? 1 : 0;
