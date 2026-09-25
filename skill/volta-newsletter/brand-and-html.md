# Brand style and HTML building blocks

Read this whenever you are writing or reviewing the newsletter body (`bodyHtml`). It must be an HTML fragment: no `<html>`, `<head>`, `<body>`, no `mc:edit`, no `<script>`, no event attributes like `onclick`, no `javascript:` links. Email clients ignore most modern CSS, so use tables and inline styles only. The server rejects a body over 200,000 characters, and checks tags rather than prose, so ordinary text like "Learn JavaScript: the basics" is fine but a `javascript:` link or an `onclick=` attribute is refused.

## Style (Volta brand on a dark background)

The template already sets a near-black background (`#0A0A0A`). Colors: main text `#F5F5F7`, body copy `#D9D9DE`, muted text `#A3A3AD`, dividers `#232327`, accent cyan `#05D9E7` (labels and links), violet `#6101FF`, coral `#FF6D6D`, amber `#FFBB0E`.

**Fonts: use single quotes around font names inside inline styles.** Double quotes inside a `style="..."` attribute silently cut the attribute off and every color after it is lost (this made all text unreadable in an earlier version). Use exactly:
`font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`

**Stay on the Volta style. This matters more than making something look different.** The newsletter is **dark**: near-black background, light text, cyan and violet accents. Never invent your own look: no white or light backgrounds, no light-theme tiles or cards, no dark text, no blue tiles, no gold or other accent colors outside the palette, no gradients you made up. Build every section from the building blocks below by **copying the block exactly and changing only its text, links and the accent color where the block allows it**. If something you need has no block (a list, a quote), compose it from the same pieces: the same dark card, the same text colors, the same fonts. Use only these colors: backgrounds and borders `#0A0A0A`, `#0A0A0C`, `#14101F`, `#232327`, `#332A55`; text `#F5F5F7`, `#D9D9DE`, `#A3A3AD`, `#FFFFFF`; accents `#05D9E7`, `#6101FF`, `#FF6D6D`, `#FFBB0E`. Never write text with a dark color, and never give an element a light background. The server refuses bodies that break this, and tells you which colors. Change the look only when the editor explicitly asks for something specific ("make it light", "use a green button"): do exactly that, confirm what will change, and save with `allowOffBrand: true`. A general request like "make it nicer" or "more modern" is not permission to leave the brand style.

## Building blocks

Copy exactly; `F` below stands for the font-family declaration above. Keep the `class` names (`vt-tile`, `vt-tile-td`, `vt-cta`, `vt-btn`) and the solid `background-image:linear-gradient(...)` next to each dark background: they stop Outlook.com's dark mode from turning the dark tiles grey. Do not remove them.

Paragraph:
```html
<p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">Text here.</p>
```

Section label:
```html
<p style="margin:0 0 6px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#05D9E7;">Volta Community Wins</p>
```

Divider between sections:
```html
<div style="height:1px;background-color:#232327;margin:28px 0;line-height:1px;font-size:0;">&nbsp;</div>
```

Link:
```html
<a href="https://example.com" style="color:#05D9E7;text-decoration:underline;">link text</a>
```

Event card (accent strip has a solid fallback color because some email clients, notably Outlook, ignore gradients):
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vt-tile" bgcolor="#0A0A0C" style="background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#6101FF" style="background-color:#6101FF;background-image:linear-gradient(180deg,#6101FF,#05D9E7,#FF6D6D,#FFBB0E);border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td class="vt-tile-td" bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);">
      <p style="margin:0 0 3px;F;font-size:15px;font-weight:600;color:#F5F5F7;">EVENT TITLE</p>
      <p style="margin:0;F;font-size:13px;color:#A3A3AD;">STARTLOCAL &middot; LOCATION</p>
      <p style="margin:6px 0 0;"><a href="EVENT_URL" style="F;font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">Sign Up &rarr;</a></p>
    </td>
  </tr>
</table>
```

AI Residency call to action (link: https://voltaeffect.com/ai-residency):
```html
<div class="vt-cta" style="background-color:#14101F;background-image:linear-gradient(#14101F,#14101F);border:1px solid #332A55;border-radius:10px;padding:20px 24px;text-align:center;">
  <p style="margin:0 0 16px;F;font-size:15px;line-height:1.6;color:#F5F5F7;">Got an idea for an AI startup? See how far you can take it with <a href="https://voltaeffect.com/ai-residency" style="color:#05D9E7;text-decoration:underline;">Volta&rsquo;s AI Residency</a>.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
    <td bgcolor="#6101FF" style="border-radius:999px;background-color:#6101FF;background-image:linear-gradient(90deg,#FF6D6D,#FFBB0E 30%,#05D9E7 65%,#6101FF);padding:2px;font-size:0;line-height:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;"><tr>
        <td class="vt-btn" bgcolor="#0A0A0A" style="border-radius:999px;background-color:#0A0A0A;background-image:linear-gradient(#0A0A0A,#0A0A0A);"><a href="https://voltaeffect.com/ai-residency" style="display:inline-block;padding:14px 36px;F;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">Apply Now</a></td>
      </tr></table>
    </td>
  </tr></table>
</div>
```

Founder spotlight card (one per featured story; change only the text and the link):
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vt-tile" bgcolor="#0A0A0C" style="background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);border:1px solid #232327;border-radius:10px;margin-bottom:14px;">
  <tr>
    <td class="vt-tile-td" bgcolor="#0A0A0C" style="padding:22px 24px;background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);">
      <p style="margin:0 0 4px;F;font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">FOUNDER NAME, COMPANY</p>
      <p style="margin:0 0 14px;F;font-size:13px;color:#A3A3AD;">One line on what the company does</p>
      <p style="margin:0 0 12px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">Story paragraph.</p>
      <p style="margin:0;"><a href="SOURCE_URL" style="F;font-size:13px;font-weight:600;color:#05D9E7;text-decoration:none;">Read more &rarr;</a></p>
    </td>
  </tr>
</table>
```

Info card (a program deadline, an opportunity or an announcement; same shape as the event card with a different accent color, `#FF6D6D` coral or `#FFBB0E` amber, on both the `bgcolor` and the `background-color`, and no gradient). Every item links to its source, so keep the link line; use the item's own page, not a home page:
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vt-tile" bgcolor="#0A0A0C" style="background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#FFBB0E" style="background-color:#FFBB0E;border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td class="vt-tile-td" bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);">
      <p style="margin:0 0 3px;F;font-size:15px;font-weight:600;color:#F5F5F7;">HEADLINE</p>
      <p style="margin:0;F;font-size:13px;line-height:1.5;color:#A3A3AD;">One or two lines of detail.</p>
      <p style="margin:6px 0 0;"><a href="SOURCE_URL" style="F;font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">Details &rarr;</a></p>
    </td>
  </tr>
</table>
```

Section heading (larger title inside a section):
```html
<p style="margin:0 0 10px;F;font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">Heading text</p>
```

### Blocks for the newsletter sections

The issue has four sections, in this order: Volta Community Wins, Coming up, The Latest AI News, A Startup Idea to Think About (with the residency call to action). Start each section with the section label block. Which block goes where:

| Section | Blocks |
|---|---|
| Volta Community Wins | Section label "Volta Community Wins", then one founder spotlight card per story |
| Coming up | Section label "Coming up", then event cards (events) and info cards (program deadlines) |
| The Latest AI News | Section label "The Latest AI News", then 1 to 5 AI news cards |
| A Startup Idea to Think About | Section label "A Startup Idea to Think About", the idea card, then the residency call to action with campaign tag |

Put a divider between sections. There is no asks-and-offers section.

AI news card (one per news item, 1 to 5 per issue; solid cyan strip, no gradient). Fill it only from the vetted item's `sanitizedText` and the page you opened. Keep "what happened" to one or two plain sentences and "why it matters" to one sentence. The last line names the source and the publication date, and links to the exact article:
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vt-tile" bgcolor="#0A0A0C" style="background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#05D9E7" style="background-color:#05D9E7;border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td class="vt-tile-td" bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);">
      <p style="margin:0 0 4px;F;font-size:15px;font-weight:600;line-height:1.4;color:#F5F5F7;">HEADLINE</p>
      <p style="margin:0 0 8px;F;font-size:14px;line-height:1.5;color:#D9D9DE;">One or two plain sentences on what happened.</p>
      <p style="margin:0 0 8px;F;font-size:13px;line-height:1.5;color:#A3A3AD;"><span style="color:#F5F5F7;font-weight:600;">Why it matters for founders:</span> one plain sentence.</p>
      <p style="margin:0;"><a href="SOURCE_URL" style="F;font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">SOURCE NAME &middot; PUBLISHED DATE &rarr;</a></p>
    </td>
  </tr>
</table>
```

Idea card (one per issue, fixed four-line layout: the idea in one line, who needs it, why now, try this in a week). The text comes from the idea you ran through `idea_check`, unchanged. The last line links the evidence pages (at least two), so every claim has a source. The idea is labeled as an idea; never rewrite it to sound like a fact:
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vt-tile" bgcolor="#0A0A0C" style="background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);border:1px solid #232327;border-radius:10px;margin-bottom:14px;">
  <tr>
    <td class="vt-tile-td" bgcolor="#0A0A0C" style="padding:22px 24px;background-color:#0A0A0C;background-image:linear-gradient(#0A0A0C,#0A0A0C);">
      <p style="margin:0 0 16px;F;font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">IDEA TITLE</p>
      <p style="margin:0 0 3px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A3A3AD;">The idea in one line</p>
      <p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#F5F5F7;">PITCH</p>
      <p style="margin:0 0 3px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A3A3AD;">Who needs it</p>
      <p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">WHO</p>
      <p style="margin:0 0 3px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A3A3AD;">Why now</p>
      <p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">WHY NOW</p>
      <p style="margin:0 0 3px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#A3A3AD;">Try this in a week</p>
      <p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">TRY THIS WEEK</p>
      <p style="margin:0;F;font-size:12px;line-height:1.5;color:#A3A3AD;">Sources: <a href="EVIDENCE_URL_1" style="color:#05D9E7;text-decoration:underline;">SOURCE NAME 1</a> &middot; <a href="EVIDENCE_URL_2" style="color:#05D9E7;text-decoration:underline;">SOURCE NAME 2</a></p>
    </td>
  </tr>
</table>
```

Residency call to action with a campaign tag (goes right after the idea card; this replaces the plain call to action above in issues that carry an idea). The paragraph is the `residencyLine` from the idea: a sentence naming Volta's AI Residency and saying what it is, then the how-to-apply fact, both taken from the live https://voltaeffect.com/ai-residency page (see `sources-and-vetting.md`); never write it from memory, and never show the how-to-apply fact alone. The link keeps the address from the live page and adds a tag so Mailchimp's click report can tell issues apart: `utm_source=newsletter`, `utm_medium=email` and `utm_campaign=newsletter-` plus the issue's date (for example `newsletter-2026-10-05`). Write `&` as `&amp;` inside `href`. Use the same address for the text and the button:
```html
<div class="vt-cta" style="background-color:#14101F;background-image:linear-gradient(#14101F,#14101F);border:1px solid #332A55;border-radius:10px;padding:20px 24px;text-align:center;">
  <p style="margin:0 0 16px;F;font-size:15px;line-height:1.6;color:#F5F5F7;">RESIDENCY LINE</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
    <td bgcolor="#6101FF" style="border-radius:999px;background-color:#6101FF;background-image:linear-gradient(90deg,#FF6D6D,#FFBB0E 30%,#05D9E7 65%,#6101FF);padding:2px;font-size:0;line-height:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;"><tr>
        <td class="vt-btn" bgcolor="#0A0A0A" style="border-radius:999px;background-color:#0A0A0A;background-image:linear-gradient(#0A0A0A,#0A0A0A);"><a href="https://voltaeffect.com/ai-residency?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=newsletter-2026-10-05" style="display:inline-block;padding:14px 36px;F;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">Apply Now</a></td>
      </tr></table>
    </td>
  </tr></table>
</div>
```

Use HTML entities for punctuation (`&rarr;`, `&middot;`, `&rsquo;`, `&amp;`). Escape `&` and `<` in text you insert, including inside `href` values (`&amp;`). Links must be full `https://` URLs. Text you insert comes from the vetted item (`sanitizedText`), never from the raw update.

Do not add other fenced `html` blocks to this file: the test harness treats every one as a building block and runs it through the server's checks.
