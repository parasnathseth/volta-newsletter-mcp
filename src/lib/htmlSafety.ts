// Safety checks for Claude-written HTML that ends up in an email. Email clients strip
// most active content themselves; this is defence in depth against accidents,
// prompt-injected content and phishing tricks. It is not a full HTML sanitizer.
//
// It looks at tags and attributes, not prose, so a sentence like "Learn JavaScript: the
// basics" is fine. Comments are scanned too: Outlook's conditional comments
// (<!--[if mso]> ... <![endif]-->) contain real markup that Outlook renders.

export type HtmlMode = 'body' | 'template';

// Never allowed anywhere: they run code, load other pages, collect input or embed content.
const NEVER_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'base', 'link', 'svg', 'math', 'portal'];
// Allowed only in the template shell (its head uses meta and a media-query style block), never in a newsletter body.
const BODY_ONLY_BLOCKED_TAGS = ['meta', 'style'];

const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'data', 'cite', 'longdesc', 'manifest', 'codebase'];
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

const NAMED_ENTITIES: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lpar: '(', rpar: ')', sol: '/' };

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

// Browsers ignore whitespace, control characters and zero-width characters inside a URL
// scheme ("java<TAB>script:"). The character class is built from code points so the source
// file contains no invisible or line-separator characters.
const IGNORED_IN_URLS = new RegExp(
  '[' +
    [[0x00, 0x20], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029], [0xfeff, 0xfeff]]
      .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
      .join('') +
    ']',
  'g',
);

const normalizeUrl = (raw: string): string => decodeEntities(raw).replace(IGNORED_IN_URLS, '').toLowerCase();

export function unsafeHtmlProblems(html: string, mode: HtmlMode = 'body'): string[] {
  const problems = new Set<string>();

  const blocked = mode === 'template' ? NEVER_TAGS : [...NEVER_TAGS, ...BODY_ONLY_BLOCKED_TAGS];
  for (const tag of blocked) {
    if (new RegExp(`<\\s*${tag}(?=[\\s>/])`, 'i').test(html)) {
      problems.add(tag === 'script' ? 'Script tags are not allowed.' : `<${tag}> tags are not allowed (${tag === 'style' || tag === 'meta' ? 'use inline styles only' : 'they can run code, load other pages or collect input'}).`);
    }
  }
  if (/<\s*meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i.test(html)) problems.add('Meta refresh redirects are not allowed.');

  // on* event-handler attributes inside a tag; also catches `<a href="x"onclick=...>` (no space).
  if (/<[a-z][^>]*[\s"'\/]on[a-z]+\s*=/i.test(html)) problems.add('Inline event handler attributes (onclick etc.) are not allowed.');

  // Every URL-bearing attribute must use a safe scheme, however it is obfuscated.
  const attr = new RegExp(`\\b(?:${URL_ATTRIBUTES.join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  for (const m of html.matchAll(attr)) {
    const url = normalizeUrl(m[1] ?? m[2] ?? m[3] ?? '');
    const scheme = /^([a-z][a-z0-9+.\-]*:)/.exec(url)?.[1];
    if (scheme && !ALLOWED_SCHEMES.includes(scheme)) {
      problems.add(scheme === 'javascript:' ? 'javascript: links are not allowed.' : `Links must use https, http, mailto or tel, not "${scheme}".`);
    }
  }

  // Old-style active CSS.
  if (/expression\s*\(|@import|behavior\s*:|-moz-binding|url\(\s*["']?\s*(?:javascript|vbscript|data)\s*:/i.test(html)) {
    problems.add('Active or external CSS (expression, @import, behavior, url(javascript:)) is not allowed.');
  }
  return [...problems];
}
