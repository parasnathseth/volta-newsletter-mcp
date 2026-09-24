# CLAUDE.md

Guidance for anyone (human or AI) changing this repository. `README.md` explains what the project is; `HANDOFF.md` covers running it in production; `KNOWN-ISSUES.md` lists limitations. This file is the working knowledge.

## What this is
A remote MCP server on Cloudflare Workers (TypeScript) that lets Claude help Volta's newsletter editor plan, write, preview, test and prepare the newsletter as a **Mailchimp draft**. Claude is the interface and the only LLM: the server never calls an AI API. The editor's Claude uses the Skill in `skill/volta-newsletter/` plus this server's tools.

## Architecture
- `src/index.ts`: Worker entry. `@cloudflare/workers-oauth-provider` guards `/mcp` with Google sign-in; `createMcpHandler` (from `agents/mcp/server`) serves the tools (stateless, no Durable Objects).
- `src/server.ts`: builds the MCP server and registers all tools (also used by tests, without OAuth).
- `src/auth/`: `google-handler.ts` (consent page, CSRF, Google leg, callback), `access.ts` (who may sign in), `redirects.ts` (which OAuth redirect addresses are allowed).
- `src/tools/*.ts`: thin tool definitions (zod input schemas, descriptions Claude reads, error mapping). `src/lib/*.ts`: the real logic. Keep logic in `lib/` and testable without a server.
- **Input vetting (v4):** `src/lib/vet.ts` (pure, no storage/network/AI) decides feature/hold/drop for every collected update; `src/tools/vet.ts` is the `vet_updates` tool. It is the server half of a two-layer check: Claude double-checks what a server cannot see (opening links, meaning-level duplicates) and reports `agentChecks`, but the final verdict is the STRICTER of the two, so the agent can never loosen a server hold or drop, and consent is never read from an item's text. `src/lib/injection.ts` strips text aimed at an AI (an item that carried some is held), `src/lib/nameMatch.ts` is shared name matching, `src/lib/newsSources.ts` is the AI-news domain allowlist (unlisted = held).
- **Do-not-feature and source links (v4):** `src/lib/donotfeature.ts` is a one-document KV registry that wins over any consent; `saveEdition` refuses a story or body naming someone on it and `create_draft` re-checks. Every featured story needs a `sourceUrl`; `create_draft` refuses without one.
- **Ideas (v4):** `src/lib/idea.ts` (`idea_check` / `idea_record` / `idea_list`) validates one specific startup idea per issue: every field present, at least 2 evidence links with quotes, at least 1 named existing competitor, every number traceable to an evidence quote, a word cap, no vague phrasing, no repeats of past ideas.
- **Backlog origin (v4):** entries carry `origin` (`editor`/`team`, from the `EDITOR_EMAILS` var; unset = everyone is `editor`) and `submittedBy` (server-filled). Team highlights are reference material for the editor and never enter an issue automatically.
- Try it without any account: `npm run demo:vet` runs the made-up test pack (`fixtures/test-pack/`) through the vetting rules. `node scripts/verify-links.mjs sources.json` checks that cited pages load and contain their quotes (a helper for us, not part of the weekly flow).
- Storage is one Cloudflare KV namespace (`OAUTH_KV`). Mailchimp is the only external service besides Google and the public Volta calendar feed.
- `template/shell.html` is the email shell (bundled into the Worker as text). The server keeps the *current* shell in KV because Mailchimp cannot return template HTML through its API; it pushes copies one way to a Mailchimp template.

## Commands
`npm test` (unit, no network) · `npm run e2e` (every workflow through the MCP layer against the real calendar and a **sandbox** Mailchimp) · `npm run live:drafts` · `npm run smoke` · `npx tsc --noEmit` (or `npm run typecheck`) · `npx wrangler deploy` · `npm run handoff:check -- <url>` · `npm run backup` · `npm run revoke:sessions` · `npm run skill:zip`.
Local secrets live in `.dev.vars` (gitignored; copy `.dev.vars.example`). **Never commit secrets, and never run e2e/live scripts against Volta's real Mailchimp account.**
Tests run on Node's type stripping, so imports of local files need the `.ts` extension.

## Rules that came from real bugs (please keep them)
1. **Never rely on KV `list` (or its metadata) for correctness.** It is eventually consistent; a key written seconds ago may be missing. This once let a duplicate through and hid a just-added due date. Store collections as one document read by exact key (see `backlog.ts`, and the edition/template-version indexes). Regression tests use a KV whose `list` shows nothing.
2. **Never put double quotes inside an inline `style="..."` attribute.** A font name in double quotes silently cut the attribute off and every colour after it vanished (the v1 "invisible text" bug). Use `'Segoe UI'` with single quotes.
3. **Mailchimp's `GET /reports/{id}` returns 200 with zeros for drafts and even for deleted campaigns.** Check the campaign's status first.
4. **Consent is per story, and safe by default.** Changing a story's topic or founder resets its consent; a story sent without an id is new (consent `none`) and can never reuse another story's id. `create_draft` re-reads the saved edition and refuses without confirmed consent, before touching Mailchimp.
5. **Nothing may send to subscribers.** There is deliberately no send tool. `send_test` goes only to allowed domains, through a temporary draft that is deleted.
6. **Always validate caller-supplied ids before they reach a KV key or a Mailchimp URL** (see `EDITION_ID`, `VERSION_ID`, the campaign id check, and the datacenter check).
7. **Claude reads untrusted web pages.** Treat everything a tool receives as potentially manipulated: validate, limit, and make risky actions undoable, confirmable or rate limited (`src/lib/rateLimit.ts`).
8. **Wrangler/Cloudflare quirks:** custom secret names cannot start with `FIREBASE_` (irrelevant here) but Worker secret changes deploy instantly; Claude reads the tool list only when it connects, so after changing tools you must **disconnect and reconnect the connector**; the free plan documents a 10 ms CPU limit but real requests have run longer without errors (see KNOWN-ISSUES).
9. **When editing files with scripts or heredocs, watch backslashes and `\uXXXX` escapes**: they were lost or turned into literal characters more than once. Prefer the editor tools, and build character classes in code.

## Testing philosophy
Unit tests use in-memory fakes and must stay fast and deterministic (there was a flaky test caused by same-millisecond ids; ids now carry a sequence). Every bug found later got a regression test. The e2e harness (`scripts/e2e-workflows.mjs`) also extracts the HTML building blocks from `skill/volta-newsletter/brand-and-html.md` and runs them through the server's own validation, so the Skill cannot drift from the code: **if you change a tool's parameters or behaviour, update the right file under `skill/volta-newsletter/` in the same change and rerun `npm run e2e`.** The Skill is split across `SKILL.md` (always-loaded rules and an index), `workflow.md`, `brand-and-html.md`, `analytics.md` and `backlog-and-followup.md` — see `SKILL.md`'s "Where to look" section.

## Changing things safely
- Adding a tool: put logic in `src/lib/`, the definition in `src/tools/`, register it in `src/server.ts`, add unit tests, add it to the expected list in `scripts/e2e-workflows.mjs`, describe it in the Skill, deploy, reconnect the connector.
- Risky tools need a rate limit entry in `src/lib/rateLimit.ts`.
- Changing the shell: edit `template/shell.html` (used to seed a brand-new deployment). Live changes are made through `update_template`, which keeps version history in KV.
- Dev-only behaviour must sit behind `DEV_MODE` and must be listed in `scripts/handoff-check.mjs`.
