# Volta Newsletter project: session context (updated 2026-09-22)

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
