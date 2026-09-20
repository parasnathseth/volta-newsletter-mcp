import type { Edition } from './edition.ts';

// Replaces the inner content of the element carrying mc:edit="<name>" with
// `inner`, handling nested elements of the same tag. HTML comments are ignored
// when locating the region (the shell's header comment mentions mc:edit).
export function replaceRegion(html: string, name: string, inner: string): string {
  // Mask comments with spaces so indexes still line up with the original.
  const masked = html.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bmc:edit\\s*=\\s*["']${name}["'][^>]*>`).exec(masked);
  if (!open) throw new Error(`Template has no mc:edit="${name}" region.`);

  const tag = open[1].toLowerCase();
  const contentStart = open.index + open[0].length;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = contentStart;

  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(masked))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, contentStart) + inner + html.slice(m.index);
  }
  throw new Error(`The mc:edit="${name}" region is not closed.`);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Full preview of an edition: the shell with the body inserted, and Mailchimp's
// merge tags replaced by preview-friendly stand-ins (Mailchimp fills the real
// values at send time).
export function renderEdition(shell: string, edition: Pick<Edition, 'bodyHtml' | 'previewText'>): string {
  const merged = replaceRegion(shell, 'body', edition.bodyHtml);
  return merged
    .replaceAll('*|MC_PREVIEW_TEXT|*', escapeHtml(edition.previewText))
    .replaceAll('*|UNSUB|*', '#')
    .replaceAll('*|LIST:ADDRESSLINE|*', '[Volta mailing address]')
    .replaceAll('*|REWARDS|*', '');
}
