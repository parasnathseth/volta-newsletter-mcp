// Exports the app's data from Cloudflare KV to a local JSON file: editions, the founder
// backlog and the template with its version history. Cloudflare KV has no automatic
// backup, so run this before risky changes and now and then. OAuth sessions and caches
// are deliberately not exported.
//
//   npm run backup            writes backups/kv-<date>.json (gitignored: it contains founder notes)
//
// Needs `npx wrangler login` on the account that owns the Worker. Read-only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const namespaceId = wrangler.kv_namespaces?.find((n) => n.binding === 'OAUTH_KV')?.id;
if (!namespaceId) { console.error('Could not find the OAUTH_KV namespace id in wrangler.jsonc'); process.exit(2); }

// Runs `npx wrangler <args>` (all arguments here are our own, trusted values). Arguments containing
// spaces are quoted, and the command is passed as one string to avoid Node's warning about shell + args.
const quote = (a) => (a.includes(' ') ? JSON.stringify(a) : a);
const wranglerCmd = (args) => ['npx', 'wrangler', ...args.map(quote)].join(' ');
const run = (cmd) => spawnSync(wranglerCmd(cmd), { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
const after = (out, ch) => out.slice(out.indexOf(ch));
// Wrangler prints a status banner before the value; drop it.
const clean = (out) => out.split('\n').filter((l) => l.trim() && !/Getting User settings|Resource location|^\s*⛅|^─+$/.test(l)).join('\n');

const PREFIXES = ['edition:', 'backlog:', 'template:'];
const keys = [];
for (const prefix of PREFIXES) {
  const res = run(['kv', 'key', 'list', '--namespace-id', namespaceId, '--remote', '--prefix', prefix]);
  try { keys.push(...JSON.parse(after(res.stdout, '[')).map((k) => k.name)); } catch { console.error('Could not list keys. Have you run `npx wrangler login`?\n' + (res.stderr || res.stdout)); process.exit(1); }
}

const data = {};
for (const key of keys) {
  const res = run(['kv', 'key', 'get', key, '--namespace-id', namespaceId, '--remote']);
  if (res.status !== 0) { console.error(`Could not read ${key}: ${res.stderr || res.stdout}`); process.exit(1); }
  const value = clean(res.stdout);
  try { data[key] = JSON.parse(value); } catch { data[key] = value; } // most values are JSON; a few pointers are plain text
}

mkdirSync(join(root, 'backups'), { recursive: true });
const file = join(root, 'backups', `kv-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), namespaceId, keyCount: keys.length, data }, null, 2));
const counts = Object.fromEntries(PREFIXES.map((p) => [p, keys.filter((k) => k.startsWith(p)).length]));
console.log(`Backed up ${keys.length} record(s) ${JSON.stringify(counts)} to ${file}`);
console.log('This file contains founder notes and unpublished newsletter content: keep it private.');
