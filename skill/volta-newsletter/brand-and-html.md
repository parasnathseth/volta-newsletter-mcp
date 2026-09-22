# Brand style and HTML building blocks

Read this whenever you are writing or reviewing the newsletter body (`bodyHtml`). It must be an HTML fragment: no `<html>`, `<head>`, `<body>`, no `mc:edit`, no `<script>`, no event attributes like `onclick`, no `javascript:` links. Email clients ignore most modern CSS, so use tables and inline styles only. The server rejects a body over 200,000 characters, and checks tags rather than prose, so ordinary text like "Learn JavaScript: the basics" is fine but a `javascript:` link or an `onclick=` attribute is refused.

## Style (Volta brand on a dark background)

The template already sets a near-black background (`#0A0A0A`). Colors: main text `#F5F5F7`, body copy `#D9D9DE`, muted text `#A3A3AD`, dividers `#232327`, accent cyan `#05D9E7` (labels and links), violet `#6101FF`, coral `#FF6D6D`, amber `#FFBB0E`.

**Fonts: use single quotes around font names inside inline styles.** Double quotes inside a `style="..."` attribute silently cut the attribute off and every color after it is lost (this made all text unreadable in an earlier version). Use exactly:
`font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`

**Stay on the Volta style. This matters more than making something look different.** The newsletter is **dark**: near-black background, light text, cyan and violet accents. Never invent your own look: no white or light backgrounds, no light-theme tiles or cards, no dark text, no blue tiles, no gold or other accent colors outside the palette, no gradients you made up. Build every section from the building blocks below by **copying the block exactly and changing only its text, links and the accent color where the block allows it**. If something you need has no block (a list, a quote), compose it from the same pieces: the same dark card, the same text colors, the same fonts. Use only these colors: backgrounds and borders `#0A0A0A`, `#0A0A0C`, `#14101F`, `#232327`, `#332A55`; text `#F5F5F7`, `#D9D9DE`, `#A3A3AD`, `#FFFFFF`; accents `#05D9E7`, `#6101FF`, `#FF6D6D`, `#FFBB0E`. Never write text with a dark color, and never give an element a light background. The server refuses bodies that break this, and tells you which colors. Change the look only when the editor explicitly asks for something specific ("make it light", "use a green button"): do exactly that, confirm what will change, and save with `allowOffBrand: true`. A general request like "make it nicer" or "more modern" is not permission to leave the brand style.

## Building blocks

Copy exactly; `F` below stands for the font-family declaration above.

Paragraph:
```html
<p style="margin:0 0 14px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">Text here.</p>
```

Section label:
```html
<p style="margin:0 0 6px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#05D9E7;">Founder Spotlight</p>
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
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#6101FF" style="background-color:#6101FF;background-image:linear-gradient(180deg,#6101FF,#05D9E7,#FF6D6D,#FFBB0E);border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;">
      <p style="margin:0 0 3px;F;font-size:15px;font-weight:600;color:#F5F5F7;">EVENT TITLE</p>
      <p style="margin:0;F;font-size:13px;color:#A3A3AD;">STARTLOCAL &middot; LOCATION</p>
      <p style="margin:6px 0 0;"><a href="EVENT_URL" style="F;font-size:12px;font-weight:600;color:#05D9E7;text-decoration:none;">Sign Up &rarr;</a></p>
    </td>
  </tr>
</table>
```

AI Residency call to action (link: https://voltaeffect.com/ai-residency):
```html
<div style="background-color:#14101F;border:1px solid #332A55;border-radius:10px;padding:20px 24px;text-align:center;">
  <p style="margin:0 0 16px;F;font-size:15px;line-height:1.6;color:#F5F5F7;">Got an idea for an AI startup? See how far you can take it with <a href="https://voltaeffect.com/ai-residency" style="color:#05D9E7;text-decoration:underline;">Volta&rsquo;s AI Residency</a>.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
    <td bgcolor="#6101FF" style="border-radius:999px;background-color:#6101FF;background-image:linear-gradient(90deg,#FF6D6D,#FFBB0E 30%,#05D9E7 65%,#6101FF);padding:2px;font-size:0;line-height:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-radius:999px;"><tr>
        <td bgcolor="#0A0A0A" style="border-radius:999px;background-color:#0A0A0A;"><a href="https://voltaeffect.com/ai-residency" style="display:inline-block;padding:14px 36px;F;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">Apply Now</a></td>
      </tr></table>
    </td>
  </tr></table>
</div>
```

Founder spotlight card (one per featured story; change only the text and the link):
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:14px;">
  <tr>
    <td bgcolor="#0A0A0C" style="padding:22px 24px;background-color:#0A0A0C;">
      <p style="margin:0 0 6px;F;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#05D9E7;">Founder Spotlight</p>
      <p style="margin:0 0 4px;F;font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">FOUNDER NAME, COMPANY</p>
      <p style="margin:0 0 14px;F;font-size:13px;color:#A3A3AD;">One line on what the company does</p>
      <p style="margin:0 0 12px;F;font-size:15px;line-height:1.6;color:#D9D9DE;">Story paragraph.</p>
      <p style="margin:0;"><a href="SOURCE_URL" style="F;font-size:13px;font-weight:600;color:#05D9E7;text-decoration:none;">Read more &rarr;</a></p>
    </td>
  </tr>
</table>
```

Info card (news, an opportunity or an announcement; same shape as the event card with a different accent color, `#FF6D6D` coral or `#FFBB0E` amber, on both the `bgcolor` and the `background-color`, and no gradient):
```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0A0C" style="background-color:#0A0A0C;border:1px solid #232327;border-radius:10px;margin-bottom:10px;">
  <tr>
    <td width="4" bgcolor="#FFBB0E" style="background-color:#FFBB0E;border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="#0A0A0C" style="padding:14px 16px;background-color:#0A0A0C;">
      <p style="margin:0 0 3px;F;font-size:15px;font-weight:600;color:#F5F5F7;">HEADLINE</p>
      <p style="margin:0;F;font-size:13px;line-height:1.5;color:#A3A3AD;">One or two lines of detail.</p>
    </td>
  </tr>
</table>
```

Section heading (larger title inside a section):
```html
<p style="margin:0 0 10px;F;font-size:20px;font-weight:700;line-height:1.3;color:#F5F5F7;">Heading text</p>
```

Use HTML entities for punctuation (`&rarr;`, `&middot;`, `&rsquo;`, `&amp;`). Escape `&` and `<` in text you insert. Links must be full `https://` URLs.
