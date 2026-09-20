// Basic safety checks for Claude-written HTML that ends up in an email. This is a
// guard against accidents and obvious abuse, not a full sanitizer.
export function unsafeHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  if (/<script[\s>]/i.test(html)) problems.push('Script tags are not allowed.');
  if (/javascript\s*:/i.test(html)) problems.push('javascript: links are not allowed.');
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('Inline event handler attributes (onclick etc.) are not allowed.');
  return problems;
}
