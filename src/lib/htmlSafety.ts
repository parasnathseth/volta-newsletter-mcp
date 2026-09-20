// Basic safety checks for Claude-written HTML that ends up in an email. This is a
// guard against accidents and obvious abuse, not a full sanitizer.
//
// The checks look at tags and attributes, not prose, so a sentence like
// "Learn JavaScript: the basics" or "we ran it once=twice" is not rejected.
export function unsafeHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  if (/<script[\s>\/]/i.test(html)) problems.push('Script tags are not allowed.');
  // javascript: as the value of a URL-bearing attribute (with or without quotes / leading spaces).
  if (/(?:href|src|action|formaction|xlink:href|background|poster)\s*=\s*["']?\s*javascript\s*:/i.test(html)) {
    problems.push('javascript: links are not allowed.');
  }
  // on* event-handler attributes inside a tag; also catches `<a href="x"onclick=...>` (no space).
  if (/<[a-z][^>]*[\s"'\/]on[a-z]+\s*=/i.test(html)) problems.push('Inline event handler attributes (onclick etc.) are not allowed.');
  return problems;
}
