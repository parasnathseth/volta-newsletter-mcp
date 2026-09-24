// Where AI news for the newsletter may come from without asking Bader first.
//
// The list is kept in code on purpose: it is short, easy to read, and cannot be changed by
// text that Claude reads on the web. A news item from a site that is NOT on this list is not
// thrown away, it is HELD so Bader can decide whether to trust it.
//
// A listed domain also covers its subdomains: "anthropic.com" allows "www.anthropic.com"
// and "news.anthropic.com". It does NOT allow lookalikes such as "notanthropic.com" or
// "anthropic.com.evil.example" (see isAllowedNewsSource).

export const NEWS_SOURCE_ALLOWLIST: string[] = [
  // Official blogs of AI labs and big AI companies
  'anthropic.com',
  'openai.com',
  'deepmind.google',
  'blog.google',
  'research.google',
  'ai.meta.com',
  'mistral.ai',
  'huggingface.co',

  // Major news outlets and science publishers
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'theverge.com',
  'techcrunch.com',
  'arstechnica.com',
  'wired.com',
  'nature.com',
  'technologyreview.com',

  // Canadian outlets and government
  'cbc.ca',
  'thestar.com',
  'theglobeandmail.com',
  'financialpost.com',
  'betakit.com',
  'canada.ca',
];

/** The host name of an http(s) link in lower case, or null if the text is not such a link. */
function hostOf(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // "example.com." (trailing dot) is the same site as "example.com".
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  return host === '' ? null : host;
}

/** True when the link's site is on the allowlist (exactly, or as a subdomain of a listed domain). */
export function isAllowedNewsSource(link: string): boolean {
  const host = hostOf(link);
  if (!host) return false;
  // The "." in `.${domain}` is what stops "notanthropic.com" from matching "anthropic.com".
  return NEWS_SOURCE_ALLOWLIST.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
