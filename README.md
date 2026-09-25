# Volta Newsletter assistant

A Claude helper that gathers what happened at Volta, checks it, and prepares the community newsletter as a **Mailchimp draft**. It is a small server (Cloudflare Workers, TypeScript) plus a Claude **Skill**. Claude is the only AI; the server is plain, strict rules. Nothing is ever sent to subscribers from here: Bader reads the draft in Mailchimp and clicks send himself.

## Who it is for

Bader, Volta's newsletter editor. He is not technical and stays in Claude and Mailchimp. A developer sets it up once (see `SETUP.md`).

## What Bader does each week

A scheduled Claude task, or Bader saying "start the newsletter", begins the run. Claude gathers the calendar, the voltaeffect.com blog and residency page, AI news since the last issue, the backlog and anything Bader pasted, then checks it all. After that:

1. **Open the result.** Claude shows what is in the issue and what is left out, with a plain reason for each.
2. **Answer the yes/no questions.** For example "Do you have Jane's OK to share this?" or "Use this idea?". Claude asks only yes/no questions.
3. **Read the full draft preview.** One complete draft is built for you to react to. Ask for changes in plain words.
4. **Optionally send yourself a test email** (Volta addresses only).
5. **Say yes.** Claude creates the Mailchimp draft.
6. **Open Mailchimp, read it, edit if you like, and send it yourself.**

Each issue has four sections: Volta Community Wins, Coming up, The Latest AI News (1 to 5 short items), and A Startup Idea to Think About with the AI Residency call to action. Every item links to its source.

## The safety promises

- **Nothing is sent.** There is no send tool. The tools can only create a draft.
- **No founder without their OK.** Consent is per story. A draft cannot be created until the editor has confirmed it, and it resets if the story changes.
- **Nobody on the do-not-feature list is named,** whatever else says yes.
- **Every item links to its source.** A featured story without a source link cannot become a draft.
- **Embargoed news waits** until its date.
- **Hidden instructions in what Claude reads cannot change what is featured.** They are removed and reported, and consent never comes from text.
- **Two layers of checking.** The server applies fixed rules; Claude then double-checks what a server cannot (it opens the links). The stricter verdict wins, and Claude can only tighten, never loosen.
- **Numbers in the startup idea must come from a cited source.**
- **Only Volta accounts can sign in,** and test emails go only to Volta addresses.

These are checks, not guarantees. Consent is still the editor's word, the server cannot open web pages, and the pattern-based checks can miss cleverly worded text. Bader reads the draft before sending. `docs/HOW-IT-WORKS.md` lists each check and its limits.

## What is built, and what is not

**Built:** live calendar events; editions with per-story consent and source links; `vet_updates` (server-side vetting) with the agent double-check; the do-not-feature list; AI news rules; the idea and residency section with `idea_check`; the founder backlog; test emails and Mailchimp drafts; analytics; template editing with undo; the Skill; setup and handoff checks.

**Not built:**
- Sign-in callbacks for other AI tools (ChatGPT, Cursor, Codex). Only Claude can connect.
- Slack or Gmail connections. Bader pastes what he wants included.
- Our own scheduler (a cron). The schedule is a Claude scheduled task on Bader's device.
- An `AGENTS.md` file.
- A local (no-server) edition.
- An asks-and-offers section. Pasted asks still get a verdict but have no section.

The `v3` git tag is the earlier version, without vetting, ideas or AI news.

**Not yet verified:** how Claude behaves with the Skill in real conversations, the scheduled task on Bader's device, Google sign-in from a Volta-owned project, and whether Mailchimp reports the residency link's campaign tags as separate links. See `KNOWN-ISSUES.md` and `HANDOFF.md`.

## Run the tests

```bash
npm install
npm test                # unit tests, no network, no accounts
npm run demo:vet        # prints the verdict table for the 24 made-up test-pack updates
npx tsc --noEmit        # type check
```

`npm run e2e`, `npm run live:drafts` and `npm run smoke` need a **sandbox** Mailchimp key in `.dev.vars` (copy `.dev.vars.example`). Never run them against Volta's real Mailchimp account.

## More

- `SETUP.md`: the one-time setup on Bader's device (about 30 minutes).
- `HANDOFF.md`: what Volta must own and configure to run this in production.
- `KNOWN-ISSUES.md`: limitations and lessons learned.
- `docs/HOW-IT-WORKS.md`: how it works and how to explain it, check by check.
- `CLAUDE.md`: working knowledge for anyone changing the code.
- `skill/volta-newsletter/`: the instructions Claude follows (`npm run skill:zip` packages them).

## For developers

`src/index.ts` is the Worker entry (Google OAuth in front of `/mcp`); `src/server.ts` registers the tools; `src/tools/` holds tool definitions and `src/lib/` the logic; `src/auth/` sign-in; `template/shell.html` the email shell; `scripts/` the tests, demo and operations scripts. Deploy with `npx wrangler deploy`, and after any deploy that changes tools, disconnect and reconnect the connector in Claude so it reloads the tool list. Secrets live in Cloudflare (`npx wrangler secret put <NAME>`), never in git.
