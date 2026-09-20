// Signs people out of the Claude connector immediately, by deleting the OAuth grant and
// token records from KV. Use it when someone leaves Volta, a laptop is lost, or you suspect
// a token was exposed. Removing someone's Google Workspace account stops NEW sign-ins right
// away, but a session that already exists keeps working until its refresh token expires
// (30 days) unless you run this.
//
//   npm run revoke:sessions                       list what would be deleted (changes nothing)
//   npm run revoke:sessions -- --confirm          sign EVERYONE out (they simply sign in again)
//   npm run revoke:sessions -- --user-id <id> --confirm    sign out one person (their Google account id, the
//                                                          second part of a "grant:<id>:..." key from the list)
//
// Needs `npx wrangler login` on the account that owns the Worker. Read/delete only KV keys
// starting with "grant:" and "token:"; editions, backlog and the template are never touched.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const userIdIndex = args.indexOf('--user-id');
const userId = userIdIndex >= 0 ? args[userIdIndex + 1] : null;
if (userIdIndex >= 0 && !userId) { console.error('--user-id needs a value'); process.exit(2); }

const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const namespaceId = wrangler.kv_namespaces?.find((n) => n.binding === 'OAUTH_KV')?.id;
if (!namespaceId) { console.error('Could not find the OAUTH_KV namespace id in wrangler.jsonc'); process.exit(2); }

// Runs `npx wrangler <args>` (all arguments here are our own, trusted values). Arguments containing
// spaces are quoted, and the command is passed as one string to avoid Node's warning about shell + args.
const quote = (a) => (a.includes(' ') ? JSON.stringify(a) : a);
const wranglerCmd = (args) => ['npx', 'wrangler', ...args.map(quote)].join(' ');
const run = (cmd) => spawnSync(wranglerCmd(cmd), { cwd: root, encoding: 'utf8', shell: true });
const parseList = (out) => JSON.parse(out.slice(out.indexOf('[')));

const keys = [];
for (const prefix of userId ? [`grant:${userId}:`, `token:${userId}:`] : ['grant:', 'token:']) {
  const res = run(['kv', 'key', 'list', '--namespace-id', namespaceId, '--remote', '--prefix', prefix]);
  try { keys.push(...parseList(res.stdout).map((k) => k.name)); } catch { console.error('Could not list keys. Have you run `npx wrangler login`?\n' + (res.stderr || res.stdout)); process.exit(1); }
}

const grants = keys.filter((k) => k.startsWith('grant:')).length;
const tokens = keys.filter((k) => k.startsWith('token:')).length;
console.log(`Found ${grants} sign-in grant(s) and ${tokens} token(s)${userId ? ` for user ${userId}` : ' in total'}.`);
if (!keys.length) process.exit(0);
if (!confirm) {
  console.log('\nThis was a preview: nothing was deleted. Add --confirm to sign these sessions out.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'revoke-'));
const file = join(dir, 'keys.json');
writeFileSync(file, JSON.stringify(keys));
const del = run(['kv', 'bulk', 'delete', file, '--namespace-id', namespaceId, '--remote', '--force']);
if (del.status !== 0) { console.error(del.stderr || del.stdout); process.exit(1); }
console.log(`Deleted ${keys.length} record(s). Those people will be asked to sign in again the next time they use the connector.`);
