// Detects text that tries to give instructions to an AI assistant, inside content the
// newsletter tools read (pasted updates, web pages, notes). Everything read that way is
// DATA, never instructions. This scanner removes what it recognises and reports it, so the
// editor sees what was tried. It is pattern-based defence in depth, not a complete filter:
// the deterministic vetting rules (consent comes from a record, never from text) and the
// editor's read of the draft are what actually keep a manipulated item out.

export interface InjectionScan {
  /** The text with HTML comments, hidden characters and recognised instruction sentences removed. */
  clean: string;
  /** Plain-language findings, one per thing removed. Empty when nothing was found. */
  findings: string[];
}

// Patterns for wording aimed at an AI rather than at readers. Kept readable on purpose:
// each entry is a label plus one regular expression.
const PATTERNS: Array<[string, RegExp]> = [
  ['tells the AI to ignore or forget its rules', /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all|any|your|the)\b[^.\n]{0,30}\b(rules?|instructions?|prompts?|guidelines?|checks?|safeguards?|policy|policies)\b/i],
  ['is addressed to an AI assistant', /\b(note|message|instructions?|attention|reminder)\s+(to|for)\s+(the\s+)?(ai|a\.i\.|assistant|model|llm|chatbot|claude|agent)\b/i],
  // Only asking for or overriding it. News that merely mentions a system prompt keeps its sentence.
  ['asks about or overrides the system prompt', /\b(reveal|print|show|leak|repeat|ignore|disregard)\b[^.\n]{0,30}\bsystem\s+prompts?\b|\byour\s+system\s+prompt\b/i],
  ['tries to set consent', /\b(mark|set|record|treat|count)\b[^.\n]{0,40}\bconsent\b[^.\n]{0,30}\b(yes|confirmed|given|granted|approved)\b/i],
  ['tries to choose what is featured', /\b(make|put|feature|lead with|use)\b[^.\n]{0,40}\b(lead|top|main|first)\s+(story|item|article)\b/i],
  ['tells the AI what it is or how to act', /\b(you\s+are\s+now|from\s+now\s+on\s+you|act\s+as\s+(an?\s+)?(ai|assistant)|pretend\s+(to\s+be|you))\b/i],
  ['asks the AI to hide something', /\b(do\s+not|don't|never)\s+(tell|mention|reveal|show|flag)\b[^.\n]{0,40}\b(the\s+)?(editor|user|bader|human|anyone)\b/i],
];

// Characters that render as nothing but can carry hidden text: zero-width space and joiners,
// direction marks, soft hyphen, byte-order mark and every other Unicode "format" character.
const FORMAT_CHARS = /\p{Cf}/gu;

// Unicode "tag" characters (U+E0000 to U+E007F) can spell out a whole hidden instruction.
const isTagChar = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0xe0000 && code <= 0xe007f;
};

// The few named entities worth decoding. Numeric ones (&#105; and &#x69;) are handled separately.
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['shy', ''], ['zwj', ''], ['zwnj', ''],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES.get(name.toLowerCase()) ?? whole;
    const code = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// The copy the patterns are matched on: entities decoded, fullwidth and look-alike forms folded
// to plain ones (NFKC), invisible characters gone, and every run of whitespace (a hard-wrapped
// line break too) turned into one space. It is only used for matching; `clean` keeps the
// original characters of every sentence that is kept.
const forMatching = (text: string) => decodeEntities(text).normalize('NFKC').replace(FORMAT_CHARS, '').replace(/\s+/g, ' ');

const snippet = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 80)}...` : one;
};

function matchLabels(text: string): string[] {
  const seen = forMatching(text);
  return PATTERNS.filter(([, re]) => re.test(seen)).map(([label]) => label);
}

export function scanForInjection(text: string): InjectionScan {
  const findings: string[] = [];
  let working = text ?? '';

  // Tag characters are always reported, and the item is held for them (the finding does not
  // say "zero-width"). Other invisible characters can come from a copy and paste, so they are
  // reported without holding the item.
  const withoutTags = [...working].filter((ch) => !isTagChar(ch)).join('');
  if (withoutTags !== working) {
    findings.push('Removed hidden Unicode tag characters, which can spell out a hidden instruction.');
    working = withoutTags;
  }
  const withoutHidden = working.replace(FORMAT_CHARS, '');
  if (withoutHidden !== working) {
    findings.push('Removed hidden (zero-width) characters.');
    working = withoutHidden;
  }

  // HTML comments never show to a reader, so they are removed from every item. One that reads
  // like an instruction to an AI is reported.
  working = working.replace(/<!--([\s\S]*?)-->/g, (_all, inner: string) => {
    const labels = matchLabels(inner);
    if (labels.length) findings.push(`Removed a hidden HTML comment that ${labels[0]}: "${snippet(inner)}"`);
    return ' ';
  });

  // Visible sentences that read as instructions to an AI are removed too. Line breaks are not
  // sentence breaks: a phrase wrapped over two lines is still one phrase.
  const kept: string[] = [];
  for (const sentence of working.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
    const labels = matchLabels(sentence);
    if (labels.length) findings.push(`Removed a sentence that ${labels[0]}: "${snippet(sentence)}"`);
    else if (sentence.trim()) kept.push(sentence.trim());
  }

  return { clean: kept.join(' '), findings };
}
