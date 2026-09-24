# Volta Newsletter project: session context (updated 2026-09-24; section 9 added for the v4 brief)

Purpose of this file: hand-off notes for continuing in a new or compacted chat. It contains no secrets. It used to sit outside the repo (`Newsletter/v3/`); moved into the repo so one link covers the code and the context together. An older summary of the v1/interview phase is `Newsletter/v1/session-context-summary.md`.

## 1. Who and why
- **Volta**: AI-first startup hub in Halifax. **Bader** = functional buyer (writes and sends the newsletter, non-technical, uses Mailchimp and AI tools, uses Claude). **Matt** = economic buyer. **Rishabh** = the user's lead, assigns the tasks.
- **Interview facts (2026-09-17):** Bader sends monthly (rejects weekly/bi-weekly), is happy with Mailchimp, spends 3-4 h per issue, hardest part is finding and researching founder stories (website -> LinkedIn/socials), asks founders' permission informally, keeps notes on who to revisit, measures with Mailchimp analytics but cannot tell if a feature helped the founder. Matt wants only verified wins shared (raising money is a milestone, not a win), values measurable outcomes and experimenting with frequency, would only back a tool switch if clearly better, raised data-governance concerns.
- **Rishabh's guidance:** built from scratch based on what they said; must be implementable; think from Volta's objectives, not just Bader's comfort; "shouldn't be something doable with a couple of prompts." Show the filesystem (CLAUDE.md, skills, memory, logs), build real agentic workflows, plug into what Bader already uses.
- **v1** (Firebase weekly-newsletter app, `Newsletter/v1/volta-newsletter`) is frozen. **v2** holds an earlier Mailchimp draft-fill deliverable, not in any repo.

## 2. What was built: the MCP server (v3, production-candidate)
Claude is the only interface. A remote MCP server on Cloudflare Workers (TypeScript) plus a Claude Skill. Drafts only: nothing is ever sent to subscribers.
- **Repo:** `github.com/parasnathseth/volta-newsletter-mcp`.
- **Live:** `https://volta-newsletter-mcp.test-mode.workers.dev/mcp` (developer's personal Cloudflare account). Free plan. One KV namespace (`OAUTH_KV`).
- **Auth:** Google sign-in via `@cloudflare/workers-oauth-provider`; only verified `@voltaeffect.com` Workspace accounts. Only Claude's redirect addresses may register/authorize. Access tokens 1 h, refresh 30 days.
- **24 tools:** events, editions (incl. `delete_edition`), Mailchimp draft/test/report, analytics (`compare_campaigns`, `get_audience_stats`), template, backlog.
- **Key behaviours:** consent is per story; `create_draft` refuses unless all consent is confirmed, and refuses re-push unless `overwrite:true`; consent resets if a story's topic or founder changes; `send_test` only to `@voltaeffect.com`; per-person hourly rate limits (including `save_edition`, `backlog_add`, `backlog_update` since v4); server-side brand-colour check on saved bodies; ids validated before touching KV/Mailchimp URLs.
- **Template:** `template/shell.html`, master copy in KV, pushed one way to Mailchimp; last 10 versions kept for undo.
- **Skill:** split (v4) into `SKILL.md` (41 lines: rules + index) + `workflow.md` + `brand-and-html.md` + `analytics.md` + `backlog-and-followup.md`, per Anthropic's progressive-disclosure guidance. Build the zip with `npm run skill:zip`.
- **Tests:** 127 unit (`npm test`), 82 end-to-end (`npm run e2e`, real calendar + Mailchimp sandbox). All pass.
- **Ops scripts:** `handoff:check`, `backup`, `revoke:sessions`, `smoke`, `skill:zip`.
- **A test hook (v4):** `.claude/settings.json` runs `npm test` automatically after any edit under `src/` or `skill/volta-newsletter/`, and reports failures back to Claude via the hook's block decision.

## 3. v4 additions (2026-09-22), driven by Rishabh's "show me the system / build agentic workflows" email
- Analytics tools, richer `get_report`, guarded `delete_edition`.
- Server-side brand-colour check (`src/lib/brand.ts`) after a real drift incident with a weaker model producing off-brand HTML.
- Skill split into five files (see above).
- An autonomous **"Monday review"** workflow: a scheduled Claude Cowork task (set up on the editor's own account — cannot be provisioned for him) pulls events, backlog and a handful of network-startup news/job leads (own company sites only — Indeed/Wellfound/Glassdoor/ZipRecruiter ToS all prohibit automated access), builds a full draft, prepares (never sends) consent-request drafts with a one-story preview artifact, and leaves a rendered preview plus analytics for the editor to react to.
- **Backlog vs. network list, clarified:** the backlog is the editor's own scratchpad; the network startup list is a separate external resource. The Skill previously conflated them (said the list "may simply be the backlog") — fixed: a search against the network list creates a **new** backlog entry, one-way handoff, never the reverse.
- New default drafting shape: build a complete first draft, then edit together (not negotiating each section before writing it) — safe because consent/brand gates are enforced server-side regardless of how the draft was produced.
- Rate limits added for `save_edition`, `backlog_add`, `backlog_update` (the automation opened a gap: an unattended run could previously write to KV without limit).
- Demo/mock startup data: `Newsletter/v3/startup-list-demo.md` (still outside the repo on purpose — explicitly mock, not wired into the shipped Skill; real data to be plugged in once Volta confirms the roster).
- Two memory files written for this project (see `~/.claude/projects/.../memory/`): what's built and how this user likes to work.

## 4. Environment and secrets (values are NOT here)
- Local: `.dev.vars` (gitignored) holds `MAILCHIMP_API_KEY` (sandbox), Google client id/secret, `DEV_MODE`, `EXTRA_ALLOWED_EMAILS`.
- Worker secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MAILCHIMP_API_KEY`, **`DEV_MODE`**, **`EXTRA_ALLOWED_EMAILS`** (dev-only, must be removed at handoff).
- Google Cloud project is in Test mode; consents expire after 7 days until a Volta-owned Internal project is used.
- No secrets in git history, 0 dependency vulnerabilities.

## 5. Problems this solves (the demo list)
Format: problem (who) -> fix.
- Assembling each issue by hand (Bader) -> live calendar filled into the template, now a one-shot full draft.
- Founder research is the slowest step (Bader) -> Claude researches with sources, plus the Monday review surfaces news/job leads automatically.
- Featuring someone without agreement (Bader, Matt) -> consent per story, drafts blocked without it, consent-request drafts with a preview link.
- Celebrating unverified wins (Matt) -> sources required, unverified claims flagged, careful framing.
- Being pushed off a tool he likes (Bader, Matt) -> output is only a Mailchimp draft he edits and sends.
- "A couple of prompts" (Rishabh) -> real integrations, safeguards, an autonomous scheduled workflow.
- Forgetting who to feature later (Bader) -> persistent backlog with notes and revisit dates, now clearly separate from the external network list.
- Not knowing if a feature helped (Bader, Matt) -> outcome recorded per story, analytics tools, follow-up drafted.
- Fixed schedule (Bader monthly, Matt experiments) -> any date window.
- Non-technical owner must stay in control (Bader) -> template changes by chat with undo; nothing can be sent; off-style drafts blocked.

## 6. Hard-won lessons (also in CLAUDE.md)
- Never rely on KV `list` for correctness.
- Never put double quotes inside an inline `style="..."`.
- Mailchimp `GET /reports/{id}` returns zeros for drafts and deleted campaigns; check campaign status first.
- After any deploy that changes tools, disconnect and reconnect the connector in Claude.
- An unattended, more autonomous workflow needs its own rate limits — a gap that only became real once the Monday review existed, not before.
- The Skill's naming conventions matter for progressive disclosure: exactly one `SKILL.md`, other files with their own descriptive names, one level deep, code blocks moved out of the always-loaded file.
- Reviewer/subagent checks and the user's own review caught real issues repeatedly (wrong-edition risk, overwrite of Mailchimp edits, consent leaking between stories, phishing via public client registration, the backlog/network-list conflation); keep using independent review.

## 7. Open items
- **Real-conversation test of the Skill** in Claude Desktop, including the new Monday review and consent-artifact flow — the one thing not verifiable by the harness.
- Production handoff not done: Volta-owned Cloudflare account, Google Internal project, real Mailchimp account and key, remove `DEV_MODE`/`EXTRA_ALLOWED_EMAILS`, name an owner (see `HANDOFF.md`).
- The consent-request preview artifact has no server-side backstop yet (only a Skill self-check) — would need stories stored with their own boundary in the edition to build one properly.
- Residual risks (in `KNOWN-ISSUES.md`): sessions outlive a suspended account up to 30 days unless `revoke:sessions`; consent is the editor's word; soft rate limits.

## 8. How the user likes to work
Uses parallel subagents where independent; wants short, concrete answers and explicit confirmation of what was checked versus assumed; likes verification through real runs rather than guesses; wants git commits/pushes only when asked and secrets kept out; time-boxes work around real deadlines. Also captured in this project's Claude memory files for continuity across sessions.

## 9. v4 brief phase (2026-09-23 to 2026-09-24): "something Bader can use on his own"
Nothing for v4 is built yet as of this note; this section records the brief and the thinking so far. `v3` is tagged locally on commit `308746a` (push it with `git push origin v3` if wanted). 127 unit and 82 e2e tests still pass at that tag.

**The brief** (`Newsletter/v4/builder-brief.pdf`, plus `volta-test-pack.zip`). Due **Thursday 2026-09-24, 11:59pm**, reviewed Friday. Goal: take v3 and package it so Bader watches a demo, says "yes, I want this", and can start almost straight away. Requirements:
- Two fixed rules: every founder story needs their OK first; every item links to its source.
- Bader sets it up and uses it on his own inside Claude Code, Cursor or Codex (instructions in `AGENTS.md` work in all three). Earlier we assumed Claude chat; the brief names these three tools, so confirm which one and his OS.
- Everything else is our call: format, sections, writing, frequency. "Start fresh" refers to the newsletter's content and format, NOT the code (I misread this earlier). The email explicitly says "take your v3 and package it".
- Think about plug-ins, e.g. a simple place where Matt, Laura and others drop weekly highlights.
- Bonus points for building our own pieces (e.g. Python scripts) instead of the built-in features (scheduled tasks, projects, routines). These are not banned; highlight it in Rishabh's demo.
- Submit via Google Form: folder or repo link with a README; one newsletter made from real sources (voltaeffect.com/events, /blog, /residency); two demo videos. Bader's demo: 3 minutes, non-technical, step by step, less time and more worth opening, address his unsubscribe worry. Rishabh's demo: 3 minutes, run from a fresh folder, walk through the pieces including what we built, show one safety check working (e.g. a story held back until they say yes).
- Don't: make slides, speed up the video, read an AI-written script, put technical detail in Bader's demo, fake an unbuilt step, send anything for real (drafts only), hand the brief to AI to build everything.
- Judged on: would Bader want it; could he use it alone (someone else sets it up from the README on Friday); is it safe (nothing made up, no founder without OK, hidden instructions in what it reads cannot change what gets featured); do we know what we built (explain any piece without AI).

**Test pack:** 24 fake updates (`updates.md`), `last-newsletter.md` (sent 2026-09-07), `do-not-feature.md`, a README. Newsletter date is 2026-10-05. Trap kinds listed by the README: duplicate news, past events, embargoed news, hidden instructions aimed at the AI, conflicting dates, no link, hearsay, old news, repeats of the last newsletter, do-not-feature people. Which updates are traps is deliberately not stated. The zip is in `Newsletter/v4/`.

**What v3 lacks against this brief:** input vetting (embargo, do-not-feature, duplicates against the last issue, past events, hidden instructions), enforcement of a source link on every item, content and reader-value design (sections, frequency), an intake for the team, and beginner onboarding. v3's safety is on the output side (consent per story, draft-only, brand check).

**Architecture forks and findings:**
- Local-first (folder + `AGENTS.md` + Python scripts + plain files; output a draft file; Mailchimp optional) vs hosted (v3's Cloudflare MCP server). Hosted is easier for Bader's own steps but heavy for a stranger to set up from a README, and it needs an owner.
- All three tools support remote MCP with OAuth and project-scoped config (`.mcp.json` for Claude Code, `.cursor/mcp.json`, `.codex/config.toml` plus `codex mcp login`). BUT v3's Phase 9 redirect allowlist only accepts claude.ai and claude.com callbacks; localhost is accepted only with `DEV_MODE`. Claude Code, Codex and (recently) Cursor use localhost callbacks, so they would be rejected. The fix would be to allow loopback in production (a deliberate security change plus a redeploy). Google OAuth is also still in Test mode (test users, 7-day expiry).
- Going local shifts the threat model: an agent with shell and file access reads untrusted inbox content; the Mailchimp key could be read from `.env`; `AGENTS.md` is a request, not a lock. Planned defence, a two-stage design: a deterministic Python stage (no LLM) parses raw inputs and decides what is featurable (consent, embargo, do-not-feature, link, date, duplicates, quarantining hidden instructions); the LLM only sees the structured survivors; a verify step checks the draft against the vetted list; Bader reads the final draft; drafts only.
- Mailchimp handoff options: (1) write a file and paste it manually (no credentials, the default), (2) a local script pushes a draft via API using his key (opt-in), (3) hosted like v3. Note: in v3, raw-HTML drafts hung in Mailchimp's editor; the template plus body-region route worked. A dedicated Mailchimp user with a limited role might make the key unable to send (unverified, check).
- Setup: an installer script does the real work (hidden input for the key so it never enters the chat); the agent is a friendly front driven by `AGENTS.md`; a deterministic `doctor` command re-checks everything. The agent must never handle the key or the Google sign-in.
- Tradeoff heuristic: automate the low-risk, high-time parts (parsing, dedupe, checks, drafting, formatting); keep a human on the high-risk parts (featuring someone, pushing to Mailchimp).

**Critique of the requirements list (kept for reference):** missing vetting and prompt-injection defence, the source-link rule, per-story consent detail (who, when, how, withdrawal, embargo), draft-only and human review, README and fresh-folder run, failure handling, logging, reader value and frequency, a definition of impact. Contradictions: "no extra cost" vs database, scheduling, auth, texting, A2A; "only @voltaeffect" vs a local tool; "sets up and connects on its own" vs a human still generating the Mailchimp key; "AI tips" vs "every item links to its source"; unattended AI runs vs cost and safety (better: scheduled Python with no AI, and the writing happens when he opens the tool). Defer or cut: A2A, texting, the golden-newsletter idea (Canadian contests based on chance generally need a skill-testing question; verify).

**Latest direction (Volta has no IT or owner): treat it as a product, not an internal dev project.** Zero-ops principles: nothing to run (no server, database or OAuth project); the user (Bader) is the operator; a plain-language `doctor`; the coding agent acts as the support layer; safe defaults (file output, no credentials needed); readable data files (CSV or Markdown for consent log, inbox, history); feeds (calendar `.ics`, blog RSS) instead of scraping, with graceful skips; pinned minimal dependencies, a changelog and one `update` step. Drop the hosted MCP, Google sign-in, KV and rate-limit infrastructure from the default; keep the ideas as Python checks; keep the `v3` tag as the documented "team edition" if Volta ever gets an owner. Intake idea: a Google Form restricted to the organization feeding a Sheet, exported to a file (only works if Volta uses Google Workspace: open question). No scheduling; the tool says when there is enough vetted news, plus a calendar reminder.

**Also decided or learned in this stretch:**
- Scheduling portability (Rishabh's feedback on Claude Scheduled Tasks): options are our own Cloudflare cron (notify-only, which keeps the "server never calls an LLM" rule), a pluggable-agent loop (LangGraph or a hand-rolled loop; the Claude Agent SDK is Claude-only; CrewAI suits multi-role work), or condition-based triggers using data we already have. MCP is the portable layer; v3's tools and guardrails are already portable.
- The test hook (`.claude/settings.json`) only fires when Claude Code is launched from `Newsletter/v3/volta-newsletter-mcp`; the earlier "not firing" was a working-directory issue, and it worked in the CLI once that was fixed.
- `Newsletter/v3/architecture-diagram.svg` and `startup-list-demo.md` (mock data, outside the repo) exist for demo use.

**Open questions for Rishabh (draft email, assume-say-build style):** which tool and OS does Bader use; may production use a one-time hosted setup, and who at Volta would own the accounts (Cloudflare, Google Workspace Internal OAuth project, Mailchimp key), or should it stay fully local; build on v3 or start fresh; is a dedicated limited Mailchimp user possible; does Volta have a written consent and data policy; does Volta use Google Workspace; is this headed to real production and by when. Because the brief is due tonight, do not wait on answers: state assumptions and build the version that works either way (the vetting and drafting core is portable).

**Next steps when work resumes:** decide local-first vs hosted using Rishabh's answers; build the deterministic vetting stage against the test pack; draft the newsletter only from vetted items with a source on every item; README plus setup script plus `doctor`; record the two demos.
