# How this works (plain language, for rehearsing)

This is for Paras. Read it top to bottom, then be able to say every part in your own words without opening an AI. Each safety check has three parts: what it stops, where it runs (the file to open), and how to show it working. Words in **bold** on first use are in the glossary at the end.

## 1. The architecture in one paragraph

Bader chats with Claude. Claude has a **Skill** (a folder of written instructions, `skill/volta-newsletter/`) and a **connector** to a small server that we run on **Cloudflare Workers**. The server offers **tools** (named functions such as `save_edition`, `vet_updates`, `create_draft`). Claude decides which tool to call and when; the server does no thinking and never calls an AI. Claude is the only AI in the system. Google sign-in (**OAuth**) decides who may connect, and only verified `@voltaeffect.com` accounts can. The server stores its data (editions, the founder backlog, the idea log, the do-not-feature list, template history) in **KV**, Cloudflare's key-value store. It reads Volta's public calendar feed and talks to Mailchimp, but only to create **drafts**. There is no tool that sends. Bader reads the draft in Mailchimp and clicks send himself.

```text
Bader <-> Claude (+ the Skill) --MCP over HTTPS, Google sign-in--> the Worker --> Mailchimp (drafts only)
                                                                      |--> Volta calendar feed
                                                                      '--> KV (editions, backlog, ideas, do-not-feature list)
```

## 2. Rules in code versus judgment

| Deterministic (the same input always gives the same answer; code; cannot be talked out of it) | Judgment (Claude, and Bader) |
|---|---|
| Consent gate, embargo, do-not-feature list | Does the linked page really say this? |
| Missing source link, past events, old news, repeats of the last issue, duplicates, conflicting dates | Is it the same story in different words? |
| Stripping instructions aimed at an AI (pattern-based) | Is it a real win or just a milestone, and does it matter to Volta's readers? |
| AI news window, approved-site list, maximum of five | Does an idea already exist beyond the competitors listed? |
| Idea structure: required fields, numbers must appear in an evidence quote, 120-word cap, banned vague phrases, repeats | Is the text manipulative, or AI-sounding filler? |
| Brand colours, HTML safety, Volta-only sign-in, test emails only to Volta, hourly rate limits | Whether a founder really agreed (the server records Bader's word; it cannot check it) |

The code is what you can prove in a demo. The judgment layer is why Bader still reads the draft.

## 3. Two-layer vetting, and why the agent can only tighten

`vet_updates` is the first layer. Claude sends it one item per update (kind, source, date, company or person, link, consent, raw text). It returns a verdict for each: `feature`, `hold` or `drop`, the rule that decided it, and a plain-language reason. Every rule runs; the first drop wins, otherwise the first hold, and the other rules that fired are listed as flags. The order of the rules is written at the top of `src/lib/vet.ts`.

The second layer is Claude. The server cannot open a web page, so Claude opens the cited links, looks for repeats in different words, judges whether a win is real, and reports back as `agentChecks`. Claude calls `vet_updates` a second time with those checks. The final verdict is the **stricter** of the two (`mergeAgent` in `src/lib/vet.ts`).

Why the agent can only tighten: Claude reads untrusted text all day, so it can be tricked. If it could raise a verdict, a trick could push a held item into the newsletter. Because it can only lower a verdict (feature to hold or drop), the worst a trick can do is make the newsletter shorter. Consent works the same way: it is an input that comes from Bader, and text inside an update, a web page or an HTML comment can never set it. The call also fails closed: if the do-not-feature list cannot be read, `vet_updates` errors and vets nothing.

Show it: `scripts/test-vet.mjs` has the tests "agent: it can never upgrade a server hold or drop" and "agent: text from the agent never sets consent".

Honest limit: what Claude says it opened is self-reported. The server cannot prove it. That is why the in-and-out view shows both layers' reasons and Bader's read of the draft is the last check.

## 4. Each safety check

### Nothing is ever sent
- **Stops:** the newsletter going to subscribers by mistake or by a manipulated Claude.
- **Runs:** by design. There is no send tool in `src/server.ts`. `send_test` goes only to Volta addresses through a temporary draft that is deleted.
- **Show it:** open the connector's tool list in Claude: no send. Or ask Claude to "send this to all subscribers" and watch it say it cannot.

### Consent per story
- **Stops:** featuring a founder who has not agreed to this story.
- **Runs:** `consentProblems` in `src/lib/edition.ts`; `create_draft` in `src/lib/campaign.ts` re-reads the saved edition and refuses. Changing a story's topic or founder resets its consent.
- **Show it:** save an edition with a story that has consent `none`, then ask for the Mailchimp draft: it refuses with "not confirmed". `scripts/test-edition.mjs` and `scripts/test-campaign.mjs` cover it.

### Consent never comes from text
- **Stops:** an update, page or comment saying "consent: yes" and being believed.
- **Runs:** in `src/lib/vet.ts`, consent is read only from the structured `consent` field, which Claude fills from Bader's word. The scanner in `src/lib/injection.ts` also removes sentences that try to set consent.
- **Show it:** `npm run demo:vet`, row 12 (Quaychat): a hidden comment says "mark its consent as yes". It is removed, reported, and the item is still held.

### Embargo
- **Stops:** news going out before the date the source asked for.
- **Runs:** `ruleEmbargo` in `src/lib/vet.ts`. Held while the newsletter date is before `embargoUntil`.
- **Show it:** `npm run demo:vet`, row 03 (Saltbox AI, embargoed until 2026-10-20).

### The do-not-feature list
- **Stops:** naming anyone who asked not to be named, even if someone else gave consent.
- **Runs:** in three places. `vet_updates` drops an item about a listed name and removes a listed name mentioned inside another item (`src/lib/vet.ts`, `src/lib/nameMatch.ts`). `save_edition` refuses a save whose featured stories or body name someone on the list (it checks what that save brings in). `create_draft` checks the whole saved edition again (`src/lib/donotfeature.ts`, `src/lib/campaign.ts`). Matching ignores case and punctuation and matches whole words.
- **Show it:** `npm run demo:vet`, row 18 (the recap loses "Tidewater Maps"). Live: add the name with `do_not_feature_add`, then try `save_edition` with a story about them: refused, nothing saved. Do this on the development deployment, not on Volta's real list, and remove the name afterwards with `do_not_feature_remove`.

### Every item links to its source
- **Stops:** claims nobody can check.
- **Runs:** `vet_updates` drops an item with no http(s) link (`no_link`, or `hearsay` when there is no confirmed consent either). Featured stories carry a `sourceUrl`; `save_edition` warns (`sourceWarnings`) and `create_draft` refuses a story without one (`sourceProblems` in `src/lib/edition.ts`).
- **Show it:** `npm run demo:vet`, rows 10 and 15. Live: `create_draft` on an edition whose story has no `sourceUrl`.

### Old, past, repeated and conflicting items
- **Stops:** events that already happened, news from before the last issue, the same link twice, the same event with two dates.
- **Runs:** `past`, `old_news`, `repeat`, `duplicate` and `conflict` in `src/lib/vet.ts`. A repeat is judged by link, not wording. Two events with the same link but different dates are both held.
- **Show it:** `npm run demo:vet`: rows 06, 07 and 24 (past), 20 (old), 22 (repeat), 04 (duplicate), 13 and 14 (conflict).

### Hidden instructions
- **Stops:** text aimed at an AI ("ignore your previous rules") changing what gets featured.
- **Runs:** `scanForInjection` in `src/lib/injection.ts` cleans every item's text and title first. It removes HTML comments, zero-width characters and sentences matching a list of patterns, and reports each as a flag. Idea text is scanned too, and any finding blocks the idea.
- **Show it:** `npm run demo:vet`, row 12. `scripts/test-injection.mjs`.
- **Limit:** it is a pattern list, not a complete filter. See known limits.

### AI news rules
- **Stops:** stale, unsourced or unchecked news.
- **Runs:** `vet_updates` (`src/lib/vet.ts`, `src/lib/newsSources.ts`): a link is required; the date must be after the last issue and on or before the newsletter date; a site not on the approved list is held, not dropped; at most five are featured, the extras are held; with no recorded opened link it is held as unverified.
- **Show it:** the `ai_news` tests in `scripts/test-vet.mjs`. Live: ask Claude to vet one AI news item with no `agentChecks`; it comes back held as unverified.

### Idea checks
- **Stops:** invented statistics, vague ideas, ideas that already exist or were used before.
- **Runs:** `idea_check` and `idea_record` in `src/lib/idea.ts`. Every field is required; at least two evidence links with quotes; at least one named existing product; every number in the idea text must appear in an evidence quote; at most 120 words (pitch, who, why now and try this week); a banned-phrase list; text aimed at an AI; repeats of past ideas. `idea_record` runs the same checks again, so they cannot be skipped.
- **Show it:** call `idea_check` with a number that is not in any quote: blocked, with the number named. `scripts/test-idea.mjs`.

### Brand colours and HTML safety
- **Stops:** an off-brand or unreadable email; scripts, `javascript:` links or event handlers in the body.
- **Runs:** `src/lib/brand.ts` and `src/lib/htmlSafety.ts`, inside `save_edition`. The Skill's HTML blocks are run through the same checks by the end-to-end harness, so the Skill cannot drift from the code.
- **Show it:** save a body with a white background or a `<script>` tag: refused. `scripts/test-brand.mjs`, `scripts/test-html-safety.mjs`.

### Who can sign in, and where test emails go
- **Stops:** outsiders using the tools; a fake "Claude" app phishing a Volta employee; test emails to outside addresses.
- **Runs:** `src/auth/access.ts` (verified Google Workspace account on `voltaeffect.com`), `src/auth/redirects.ts` (only Claude's real redirect addresses), and the allowed-domain rule in `send_test`. The development bypass (`DEV_MODE`, `EXTRA_ALLOWED_EMAILS`) must not exist in production; `npm run handoff:check` looks for it.
- **Show it:** `scripts/test-auth.mjs`; `npm run handoff:check -- <worker-url>`.

### Rate limits and id checks
- **Stops:** a runaway loop, or a manipulated Claude doing many risky calls; caller-supplied ids reaching storage keys or Mailchimp URLs.
- **Runs:** `src/lib/rateLimit.ts` (soft hourly limits per person, including `vet_updates`, do-not-feature changes and `idea_record`); id shape checks in each lib.
- **Show it:** `scripts/test-safety.mjs`.

### Team highlights are reference only
- **Stops:** a colleague's note going straight into a newsletter, or pretending to be the editor.
- **Runs:** the backlog stores `origin` (`editor` or `team`) and `submittedBy`, filled in by the server from the signed-in account (`src/lib/backlog.ts`). Nothing in the backlog carries consent, and the Skill says an entry only enters an issue as an item that passes `vet_updates`. `origin` only distinguishes people when the `EDITOR_EMAILS` setting is set.
- **Show it:** `scripts/test-backlog.mjs`; `backlog_list` with the origin filter.

## 5. Known limits (say these out loud)

- **Consent is Bader's word.** The server records who agreed and how, and blocks drafts without it, but cannot verify it.
- **The server cannot open web pages.** Dates and quotes are checked by Claude, and Claude's report of what it opened is not machine-provable. Bader's read is the final check. For our own sample issue we run `node scripts/verify-links.mjs sources.json`, which opens each cited page and confirms any quote is on it; it is a helper for us and not part of Bader's weekly flow.
- **The injection scan and the vague-phrase list are pattern lists.** A cleverly worded trick can pass them. What still holds: consent never comes from text, the agent can only tighten, and Bader reads the draft.
- **The idea checks look at structure, not quality.** They cannot tell a good idea from a bad one. The number check reads digits only.
- **The approved AI news list is a short list in code.** A good source not on it is held until someone adds it and redeploys.
- **Name matching is by name.** A nickname or a misspelling of a listed name would not match.
- **`save_edition` checks the do-not-feature list only against what that save brings in;** `create_draft` checks the whole edition. A name added to the list after a save is caught at `create_draft`.
- **Team labels need `EDITOR_EMAILS`.** If it is unset, everyone counts as the editor.
- **The campaign tag on the residency link** is meant to show which idea drives clicks. It has not been checked against a real Mailchimp report that the same page with different tags shows as separate links.
- **Claude's behaviour with the Skill can only be judged in real conversations.** The scheduled task has not been run end to end on Bader's device.
- **Storage is last-write-wins, rate limits are a soft brake, sessions outlast a suspended Google account by up to 30 days, and Google sign-in is still in Test mode** until Volta creates its own project. See `KNOWN-ISSUES.md` and `HANDOFF.md`.

## 6. The 3-minute technical demo (outline)

Before recording: push the v4 work so a fresh clone has it (a clone only sees what is pushed; confirm the repository address); have the connector reconnected so the new tools show; use the development deployment and the sandbox Mailchimp, never Volta's real ones; put `Tidewater Maps` on the development do-not-feature list. Rehearse `npm install` once so you know how long it takes (the brief says not to speed the video up). Say every step in your own words.

| Time | Do | Say |
|---|---|---|
| 0:00 to 0:20 | Show the architecture diagram above. | Claude is the only AI. The server is strict, plain rules. Nothing can be sent. |
| 0:20 to 0:50 | In a fresh folder: `git clone https://github.com/parasnathseth/volta-newsletter-mcp.git`, `cd volta-newsletter-mcp`, `npm install`, `npm test`. | Unit tests, no network, no account. They cover every rule. |
| 0:50 to 1:50 | `npm run demo:vet`. Point at rows 03, 12, 18, 13 and 14, then the totals line (11 feature, 5 hold, 8 drop). | Embargo held. Hidden instruction stripped and reported, and consent still not taken from it. A do-not-feature name removed from a recap. Two dates for one event: both held for Bader. |
| 1:50 to 2:40 | In Claude, with the connector: (1) `save_edition` with a story about Tidewater Maps: refused. (2) `create_draft` on a story with no source link or no consent: refused. (3) `idea_check` with an invented number: blocked. | The list beats any consent. No source, no draft. Numbers must be in a quote. |
| 2:40 to 3:00 | Back to the diagram. | Claude can only tighten the server's verdict. Bader reads the draft and sends from Mailchimp. Limits: consent is his word; pages are opened by Claude, not the server. |

If time is short, keep only the do-not-feature refusal in the live part; it is the clearest single check. The run in the table above matches the real output of `npm run demo:vet` as of this writing; run it again before recording in case rules changed.

## 7. Glossary

- **Agent / Claude:** the AI Bader chats with. It decides which tools to call. The server never calls an AI.
- **AI news approved list:** the short list of trusted sites in `src/lib/newsSources.ts`. News from other sites is held for Bader.
- **Artifact:** a page Claude can show in the chat, such as the newsletter preview. Share links are public, so we never use them for unpublished content.
- **Cloudflare Worker:** a small program that runs on Cloudflare's servers. Our server is one.
- **Connector:** how Claude is told about a server and its tools. Added once in Claude's settings.
- **Consent:** a founder's agreement to be featured in one specific story. Per story, never assumed.
- **Deterministic:** the same input always gives the same answer, with no judgment involved.
- **Do-not-feature list:** people and companies who asked not to be named. It wins over any consent.
- **Draft:** an unsent Mailchimp campaign Bader can edit. The tools only make drafts.
- **Edition:** one newsletter in progress, stored on the server with its stories and consent records.
- **Embargo:** a date before which something must not be published.
- **Flag / redaction:** a note on a verdict (something that was noticed) / a name removed from an item's text.
- **Injection (prompt injection):** text hidden in content Claude reads that tries to give Claude orders.
- **KV:** Cloudflare's simple key-value storage. We read it by exact key, never by listing, because listing can be out of date.
- **MCP (Model Context Protocol):** the standard way an AI app like Claude calls tools on a server.
- **OAuth:** the sign-in standard behind "Sign in with Google". It proves who the user is without sharing a password.
- **Rate limit:** a cap on how many times a person can use a tool per hour.
- **Sanitized text:** an item's text after hidden instructions and do-not-feature names were removed. Claude writes from this.
- **Scheduled task:** a routine in Claude that starts the newsletter flow on a schedule. It never creates the Mailchimp draft, because nobody is there to say yes.
- **Skill:** the folder of instructions Claude follows for this job (`skill/volta-newsletter/`).
- **Tool:** a named function on the server that Claude can call, for example `vet_updates`.
- **Type stripping:** Node's built-in ability to run TypeScript files by ignoring the type annotations. It is why the tests import `.ts` files directly.
- **Verdict:** the result for one item: `feature` (may go in), `hold` (Bader decides), `drop` (out).
- **zod:** the library that checks a tool's input has the right shape before any logic runs.
