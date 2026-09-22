// Keeps newsletter bodies on Volta's dark brand style. The template shell is dark (#0A0A0A) with light text,
// and the Skill gives Claude building blocks in the brand colours. Weaker models sometimes invent their own
// look (light tiles, dark text on the dark background, off-palette accents), so save_edition checks the colours
// used in a body and refuses ones that are not part of the brand unless the editor explicitly asked for them
// (allowOffBrand). This is a colour check, not a design review: it catches the drift that makes emails unreadable.

const BRAND = {
  dark: ['0A0A0A', '0A0A0C', '14101F', '232327', '332A55'], // backgrounds, borders, dividers
  lightNeutrals: ['FFFFFF', 'F5F5F7', 'D9D9DE', 'A3A3AD'], // text colours only, never a background
  accents: ['05D9E7', '6101FF', 'FF6D6D', 'FFBB0E'], // cyan, violet, coral, amber
};

const PALETTE = new Set([...BRAND.dark, ...BRAND.lightNeutrals, ...BRAND.accents]);
const DARK = new Set(BRAND.dark);
const LIGHT_NEUTRAL = new Set(BRAND.lightNeutrals);

// The common CSS colour names. Anything else spelled as a word (transparent, inherit, none) is fine.
const NAMED = new Set(
  ('white black gray grey silver red blue green yellow orange gold purple pink navy teal cyan aqua magenta brown maroon lime olive fuchsia indigo violet ' +
    'crimson coral salmon tomato orchid khaki beige ivory lavender turquoise skyblue lightblue darkblue lightgray lightgrey darkgray darkgrey whitesmoke ' +
    'gainsboro azure tan plum lightgreen darkgreen royalblue steelblue dodgerblue deepskyblue cornflowerblue goldenrod lightyellow lightpink hotpink ' +
    'darkred darkorange mintcream snow linen aliceblue ghostwhite floralwhite honeydew seashell').split(' '),
);

// CSS properties whose values can hold a colour. Font properties are skipped so a font called "Arial Black" is not misread.
const COLOR_PROPS = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|box-shadow|text-shadow|fill|stroke|text-decoration|text-decoration-color)$/;

const normHex = (raw: string): string => {
  let h = raw.replace('#', '').toUpperCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  return h.slice(0, 6);
};

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface Decl {
  prop: string;
  value: string;
}

/** Every colour-bearing declaration in the inline styles of a fragment, plus bgcolor/color attributes. Each item is one element's styling. */
function elementDecls(html: string): Decl[][] {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const out: Decl[][] = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(noComments))) {
    const attrs = t[2];
    const decls: Decl[] = [];
    const styleRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let s: RegExpExecArray | null;
    while ((s = styleRe.exec(attrs))) {
      for (const part of (s[1] ?? s[2] ?? '').split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const prop = part.slice(0, i).trim().toLowerCase();
        if (COLOR_PROPS.test(prop)) decls.push({ prop, value: part.slice(i + 1) });
      }
    }
    const attrRe = /(?:^|\s)(bgcolor|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrs))) decls.push({ prop: a[1].toLowerCase() === 'bgcolor' ? 'background-color' : 'color', value: a[2] ?? a[3] ?? '' });
    if (decls.length) out.push(decls);
  }
  return out;
}

/**
 * Problems with the colours used in a newsletter body, as plain sentences for Claude to act on. Empty means the body
 * stays on brand. Colours must come from the brand palette; light colours may not be used as backgrounds (that
 * produces light tiles on the dark email); dark colours may not be used as text unless the element has a bright
 * background of its own.
 */
export function offBrandProblems(html: string): string[] {
  const off = new Set<string>();
  const lightBg = new Set<string>();
  const darkText = new Set<string>();
  const functions = new Set<string>();
  const names = new Set<string>();

  for (const decls of elementDecls(html)) {
    const brightBackground = decls.some(
      (d) => /^background/.test(d.prop) && (d.value.match(/#[0-9a-f]{3,8}\b/gi) ?? []).some((h) => luminance(normHex(h)) > 0.35 && PALETTE.has(normHex(h)) && !LIGHT_NEUTRAL.has(normHex(h))),
    );
    for (const { prop, value } of decls) {
      const cleaned = value.replace(/url\([^)]*\)/gi, ' ').replace(/(["']).*?\1/g, ' ');
      for (const fn of cleaned.match(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/gi) ?? []) functions.add(fn.replace(/\s*\($/, '').toLowerCase());
      for (const raw of cleaned.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
        const h = normHex(raw);
        if (!PALETTE.has(h)) off.add(`#${h}`);
        else if (/^background/.test(prop) && LIGHT_NEUTRAL.has(h)) lightBg.add(`#${h}`);
        else if (prop === 'color' && DARK.has(h) && !brightBackground) darkText.add(`#${h}`);
      }
      const words = cleaned.replace(/#[0-9a-f]{3,8}\b/gi, ' ').replace(/[a-z-]+\s*\(/gi, ' ').match(/[a-z]+/gi) ?? [];
      for (const w of words) if (NAMED.has(w.toLowerCase())) names.add(w.toLowerCase());
    }
  }

  const problems: string[] = [];
  if (off.size) problems.push(`These colours are not Volta brand colours: ${[...off].slice(0, 6).join(', ')}.`);
  if (names.size) problems.push(`Colour names are not allowed (${[...names].slice(0, 6).join(', ')}); use the brand hex colours.`);
  if (functions.size) problems.push(`Colour functions (${[...functions].join(', ')}) are not allowed; use the brand hex colours.`);
  if (lightBg.size) problems.push(`Light backgrounds (${[...lightBg].join(', ')}) would put a light tile on the dark newsletter. Backgrounds must be the dark brand colours.`);
  if (darkText.size) problems.push(`Dark text colours (${[...darkText].join(', ')}) would be unreadable on the dark newsletter. Use the light text colours.`);
  return problems;
}

/** The brand palette as text, for tool descriptions and error messages. */
export const BRAND_SUMMARY =
  'Backgrounds and borders: #0A0A0A, #0A0A0C, #14101F, #232327, #332A55. Text: #F5F5F7, #D9D9DE, #A3A3AD, #FFFFFF. Accents: cyan #05D9E7, violet #6101FF, coral #FF6D6D, amber #FFBB0E.';
