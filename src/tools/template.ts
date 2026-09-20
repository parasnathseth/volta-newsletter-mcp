import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { logEvent } from '../lib/log.ts';
import { textResult } from '../lib/mcp.ts';
import { getTemplateState, listVersions, restoreVersion, updateTemplate, ValidationError, MAX_VERSIONS } from '../lib/template.ts';
import type { Env } from '../types.ts';

const fail = (message: string) => ({ ...textResult(message), isError: true });
const warn = (w: string[]) => (w.length ? ` Warning: ${w.join(' ')}` : '');

export function registerTemplateTools(server: McpServer, env: Env, bundledShell: string, userEmail: () => string | undefined): void {
  const user = () => userEmail() ?? 'unknown';

  server.registerTool(
    'get_template',
    {
      description:
        'Returns the newsletter template shell (the HTML wrapper: header, footer, brand styles) that every newsletter is placed into. It has exactly one editable region, mc:edit="body"; the newsletter body you compose is inserted there. Use this to preview a newsletter (put the body HTML inside the region) or before changing the design with update_template.',
      inputSchema: {},
    },
    async () => {
      try {
        const t = await getTemplateState(env, bundledShell);
        logEvent('tool.get_template', { user: user() });
        return textResult(
          JSON.stringify({
            html: t.html,
            bodyRegion: 'mc:edit="body"',
            mailchimpTemplateId: t.mailchimpTemplateId,
            lastUpdatedAt: t.updatedAt,
            lastUpdatedBy: t.updatedBy,
            lastNote: t.note,
          }),
        );
      } catch (err) {
        logEvent('tool.get_template.error', { user: user(), message: (err as Error).message });
        return fail(`Could not load the template: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'update_template',
    {
      description:
        `Replaces the newsletter template shell with new full HTML (start from get_template and change only what was asked). Requirements: exactly one mc:edit="body" region, the footer merge tags *|UNSUB|* and *|LIST:ADDRESSLINE|*, and no scripts or event-handler attributes. The previous version is saved automatically (newest ${MAX_VERSIONS} kept) so it can be undone with restore_template. Always show the user a preview and get their confirmation before calling this.`,
      inputSchema: {
        html: z.string().describe('The complete new template HTML.'),
        note: z.string().describe('Short description of what changed, e.g. "made the button green".'),
      },
    },
    async ({ html, note }) => {
      try {
        const r = await updateTemplate(env, bundledShell, { html, note, by: user() });
        logEvent('tool.update_template', { user: user(), changed: r.changed, versionId: r.versionId });
        return textResult(
          r.changed
            ? `Template updated. The previous version was saved as "${r.versionId}"; to undo, call restore_template with versionId "${r.versionId}".${warn(r.warnings)}`
            : `No change: the new HTML is identical to the current template.${warn(r.warnings)}`,
        );
      } catch (err) {
        logEvent('tool.update_template.error', { user: user(), message: (err as Error).message });
        return fail(err instanceof ValidationError ? err.message : `Could not update the template: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'list_template_versions',
    {
      description: `Lists saved previous versions of the template shell, newest first (up to ${MAX_VERSIONS}). Each version is the template as it was before a change, with who changed it and the note.`,
      inputSchema: {},
    },
    async () => {
      try {
        const versions = await listVersions(env);
        logEvent('tool.list_template_versions', { user: user(), count: versions.length });
        return textResult(JSON.stringify({ count: versions.length, versions }));
      } catch (err) {
        return fail(`Could not list versions: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'restore_template',
    {
      description:
        'Restores a previous template version, undoing a change. Use versionId "previous" to undo the most recent update, or an id from list_template_versions. The restore is itself saved as a new version, so it can be undone too.',
      inputSchema: { versionId: z.string().describe('A version id from list_template_versions, or "previous".') },
    },
    async ({ versionId }) => {
      try {
        const r = await restoreVersion(env, bundledShell, { versionId, by: user() });
        logEvent('tool.restore_template', { user: user(), restoredFrom: r.restoredFrom, changed: r.changed });
        return textResult(
          r.changed
            ? `Restored version "${r.restoredFrom}". The template as it was before this restore is saved as "${r.versionId}".${warn(r.warnings)}`
            : `The template already matches version "${r.restoredFrom}"; nothing changed.`,
        );
      } catch (err) {
        logEvent('tool.restore_template.error', { user: user(), message: (err as Error).message });
        return fail(err instanceof ValidationError ? err.message : `Could not restore: ${(err as Error).message}`);
      }
    },
  );
}
