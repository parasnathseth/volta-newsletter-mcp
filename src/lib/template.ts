import { mailchimp, type MailchimpEnv } from './mailchimp.ts';
import { unsafeHtmlProblems } from './htmlSafety.ts';

// The shell template's HTML is stored in KV as the source of truth, because
// Mailchimp accepts template HTML but never returns it through the API (GET
// /templates/{id} has no html field). Mailchimp holds the deployed copy; KV
// holds the current copy plus the last MAX_VERSIONS previous versions for undo.
//
// Known limitation: if someone edits the template directly in the Mailchimp
// editor, KV will not know about it (see KNOWN-ISSUES.md).

export interface TemplateEnv extends MailchimpEnv {
  OAUTH_KV: KVNamespace;
}

export interface TemplateState {
  html: string;
  mailchimpTemplateId: number;
  updatedAt: string;
  updatedBy: string;
  note: string;
}

export interface VersionInfo {
  versionId: string;
  createdAt: string;
  by: string;
  note: string;
  bytes: number;
}

export const TEMPLATE_NAME = 'Volta Newsletter Shell';
export const MAX_VERSIONS = 10;
const CURRENT_KEY = 'template:current';
const VERSION_PREFIX = 'template:version:';
const LATEST_POINTER_KEY = 'template:latestVersion';
const VERSION_INDEX_KEY = 'template:versionIndex';
const MAX_HTML_CHARS = 300_000;

export class ValidationError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Template not saved: ${problems.join(' ')}`);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/** Returns a list of problems; empty means the shell is safe to push. */
export function validateShell(html: string): string[] {
  const problems: string[] = [];
  if (!html.trim()) return ['The template is empty.'];
  if (html.length > MAX_HTML_CHARS) problems.push(`The template is too large (${html.length} characters, max ${MAX_HTML_CHARS}).`);

  // Comments may mention mc:edit in prose; only real attributes count.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const regions = [...withoutComments.matchAll(/mc:edit\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const bodyCount = regions.filter((r) => r === 'body').length;
  if (bodyCount !== 1) problems.push(`It must contain exactly one editable region mc:edit="body" (found ${bodyCount}).`);
  const others = regions.filter((r) => r !== 'body');
  if (others.length) problems.push(`Only the "body" editable region is supported (also found: ${others.join(', ')}).`);

  if (!withoutComments.includes('*|UNSUB|*')) problems.push('The footer must include the unsubscribe merge tag *|UNSUB|*.');
  if (!withoutComments.includes('*|LIST:ADDRESSLINE|*')) problems.push('The footer must include the mailing address merge tag *|LIST:ADDRESSLINE|*.');
  problems.push(...unsafeHtmlProblems(html));
  return problems;
}

/** Non-blocking advice about a shell that is valid but may not send on some Mailchimp plans. */
export function shellWarnings(html: string): string[] {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const warnings: string[] = [];
  if (!withoutComments.includes('*|REWARDS|*')) {
    warnings.push('The footer has no *|REWARDS|* tag. The Mailchimp Free plan requires it and will append its own footer or block sending without it; paid plans do not.');
  }
  return warnings;
}

/** Current template, seeding KV and Mailchimp from the bundled shell on first use. */
export async function getTemplateState(env: TemplateEnv, bundledShell: string): Promise<TemplateState> {
  const existing = (await env.OAUTH_KV.get(CURRENT_KEY, 'json')) as TemplateState | null;
  if (existing) return existing;

  const problems = validateShell(bundledShell);
  if (problems.length) throw new Error(`Bundled shell is invalid: ${problems.join(' ')}`);

  // Reuse a same-named template if KV was wiped, to avoid duplicates.
  const list = await mailchimp<{ templates: { id: number; name: string }[] }>(env, 'GET', '/templates?type=user&count=100');
  const found = list.templates?.find((t) => t.name === TEMPLATE_NAME);
  let id: number;
  if (found) {
    id = found.id;
    await mailchimp(env, 'PATCH', `/templates/${id}`, { html: bundledShell });
  } else {
    id = (await mailchimp<{ id: number }>(env, 'POST', '/templates', { name: TEMPLATE_NAME, html: bundledShell })).id;
  }

  const state: TemplateState = {
    html: bundledShell,
    mailchimpTemplateId: id,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
    note: 'Initial version from the bundled shell.',
  };
  await env.OAUTH_KV.put(CURRENT_KEY, JSON.stringify(state));
  return state;
}

export async function updateTemplate(
  env: TemplateEnv,
  bundledShell: string,
  args: { html: string; note: string; by: string },
): Promise<{ changed: boolean; versionId?: string; state: TemplateState; warnings: string[] }> {
  const problems = validateShell(args.html);
  if (problems.length) throw new ValidationError(problems);

  const current = await getTemplateState(env, bundledShell);
  const warnings = shellWarnings(args.html);
  if (args.html === current.html) return { changed: false, state: current, warnings };

  // Push to Mailchimp first: if it fails, KV (source of truth) stays unchanged.
  await mailchimp(env, 'PATCH', `/templates/${current.mailchimpTemplateId}`, { html: args.html });

  const now = new Date().toISOString();
  // Ids sort as timestamp + sequence number. The sequence keeps ordering exact even if
  // two updates land in the same millisecond (a random suffix would order them randomly).
  const existingVersions = await listVersions(env);
  const nextSeq = Math.max(0, ...existingVersions.map((v) => Number(/-(\d{6})$/.exec(v.versionId)?.[1] ?? 0))) + 1;
  const versionId = `${now}-${String(nextSeq).padStart(6, '0')}`;
  const note = args.note.trim().slice(0, 200) || 'template update';
  const info: VersionInfo = { versionId, createdAt: now, by: args.by, note, bytes: new TextEncoder().encode(current.html).length };
  await env.OAUTH_KV.put(`${VERSION_PREFIX}${versionId}`, JSON.stringify({ html: current.html }), {
    metadata: { createdAt: info.createdAt, by: info.by, note: info.note, bytes: info.bytes },
  });
  await env.OAUTH_KV.put(LATEST_POINTER_KEY, versionId);

  const state: TemplateState = { ...current, html: args.html, updatedAt: now, updatedBy: args.by, note };
  await env.OAUTH_KV.put(CURRENT_KEY, JSON.stringify(state));

  // Keep only the newest MAX_VERSIONS: the index document decides, not a (possibly stale) KV listing.
  const index = [...existingVersions, info];
  index.sort(newestFirst);
  await env.OAUTH_KV.put(VERSION_INDEX_KEY, JSON.stringify(index.slice(0, MAX_VERSIONS)));
  for (const v of index.slice(MAX_VERSIONS)) await env.OAUTH_KV.delete(`${VERSION_PREFIX}${v.versionId}`);
  return { changed: true, versionId, state, warnings };
}

const newestFirst = (a: VersionInfo, b: VersionInfo) => (a.versionId < b.versionId ? 1 : -1);

// Version history is an index document read by exact key (read-your-writes). KV `list`
// is eventually consistent, so scanning it is only a fallback for history saved before
// the index existed.
export async function listVersions(env: TemplateEnv): Promise<VersionInfo[]> {
  const idx = (await env.OAUTH_KV.get(VERSION_INDEX_KEY, 'json')) as VersionInfo[] | null;
  if (idx) return [...idx].sort(newestFirst);
  return scanVersionKeys(env);
}

async function scanVersionKeys(env: TemplateEnv): Promise<VersionInfo[]> {
  const out: VersionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list<{ createdAt: string; by: string; note: string; bytes: number }>({ prefix: VERSION_PREFIX, cursor });
    for (const k of page.keys) {
      out.push({
        versionId: k.name.slice(VERSION_PREFIX.length),
        createdAt: k.metadata?.createdAt ?? '',
        by: k.metadata?.by ?? '',
        note: k.metadata?.note ?? '',
        bytes: k.metadata?.bytes ?? 0,
      });
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return out.sort(newestFirst);
}

/** Restores a saved version (or "previous" = undo the last update). The restore itself is saved as a new version, so it can be undone too. */
export async function restoreVersion(
  env: TemplateEnv,
  bundledShell: string,
  args: { versionId: string; by: string },
): Promise<{ restoredFrom: string; changed: boolean; versionId?: string; state: TemplateState; warnings: string[] }> {
  let id = args.versionId;
  if (id === 'previous') {
    const pointer = await env.OAUTH_KV.get(LATEST_POINTER_KEY);
    if (!pointer) throw new Error('There is no previous version to restore yet.');
    id = pointer;
  }
  const saved = (await env.OAUTH_KV.get(`${VERSION_PREFIX}${id}`, 'json')) as { html: string } | null;
  if (!saved) throw new Error(`Version "${id}" was not found (only the newest ${MAX_VERSIONS} versions are kept).`);
  const result = await updateTemplate(env, bundledShell, { html: saved.html, note: `restored version ${id}`, by: args.by });
  return { restoredFrom: id, ...result };
}
