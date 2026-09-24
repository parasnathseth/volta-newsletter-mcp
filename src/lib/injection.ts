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
  ['talks about the system prompt', /\bsystem\s+prompt\b/i],
  ['tries to set consent', /\b(mark|set|record|treat|count)\b[^.\n]{0,40}\bconsent\b[^.\n]{0,30}\b(yes|confirmed|given|granted|approved)\b/i],
  ['tries to choose what is featured', /\b(make|put|feature|lead with|use)\b[^.\n]{0,40}\b(lead|top|main|first)\s+(story|item|article)\b/i],
  ['tells the AI what it is or how to act', /\b(you\s+are\s+now|from\s+now\s+on\s+you|act\s+as\s+(an?\s+)?(ai|assistant)|pretend\s+(to\s+be|you))\b/i],
  ['asks the AI to hide something', /\b(do\s+not|don't|never)\s+(tell|mention|reveal|show|flag)\b[^.\n]{0,40}\b(the\s+)?(editor|user|bader|human|anyone)\b/i],
];

// Characters that render as nothing but can carry hidden text: zero-width space/joiners,
// direction marks, word joiner and byte-order mark. Built from code points so the source
// file holds no invisible characters.
const HIDDEN_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff];
const HIDDEN_CHARS = new RegExp(`[${HIDDEN_CODE_POINTS.map((c) => String.fromCharCode(c)).join('')}]`, 'g');

const snippet = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 80)}...` : one;
};

function matchLabels(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export function scanForInjection(text: string): InjectionScan {
  const findings: string[] = [];
  let working = text ?? '';

  if (HIDDEN_CHARS.test(working)) {
    findings.push('Removed hidden (zero-width) characters.');
    working = working.replace(HIDDEN_CHARS, '');
  }
  HIDDEN_CHARS.lastIndex = 0;

  // HTML comments never show to a reader, so they are removed from every item. One that reads
  // like an instruction to an AI is reported.
  working = working.replace(/<!--([\s\S]*?)-->/g, (_all, inner: string) => {
    const labels = matchLabels(inner);
    if (labels.length) findings.push(`Removed a hidden HTML comment that ${labels[0]}: "${snippet(inner)}"`);
    return ' ';
  });

  // Visible sentences that read as instructions to an AI are removed too.
  const kept: string[] = [];
  for (const sentence of working.split(/(?<=[.!?])\s+|\n+/)) {
    const labels = matchLabels(sentence);
    if (labels.length) findings.push(`Removed a sentence that ${labels[0]}: "${snippet(sentence)}"`);
    else if (sentence.trim()) kept.push(sentence.trim());
  }

  return { clean: kept.join(' '), findings };
}
