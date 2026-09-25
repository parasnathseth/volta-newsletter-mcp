# One-time setup (about 30 minutes on Bader's device)

For the developer setting this up with Bader. Bader must be there to sign in. Steps marked **[Volta account]** need an account that Volta owns (Cloudflare, Google Workspace, Mailchimp). If Volta does not have those yet, stop after Part 1 and finish `HANDOFF.md` first; do not set up on personal accounts and call it done.

`<worker-url>` below means the address of the deployed Worker, for example `https://volta-newsletter-mcp.<account>.workers.dev`.

## Part 1: Before you sit with Bader (at your desk)

- [ ] **1. Read `HANDOFF.md` and copy what is true.** Write a short note for Volta: who the owner and backup owner are, which Cloudflare, Google and Mailchimp accounts exist, and which HANDOFF sections are done. If a box is not done, say so; do not guess.
- [ ] **2. Deploy to Volta's Cloudflare account and note `<worker-url>`.** **[Volta account]** (HANDOFF section 2). The address in use today is on the developer's personal Cloudflare account. It is fine for rehearsal but not for production, and stored data does not move between accounts.
- [ ] **3. Google sign-in from a Volta-owned project.** **[Volta account]** See "Google sign-in" below. The client id and secret go on the Worker in step 4.
- [ ] **4. Set the secrets.** `npx wrangler secret put GOOGLE_CLIENT_ID`, `npx wrangler secret put GOOGLE_CLIENT_SECRET`, and `npx wrangler secret put MAILCHIMP_API_KEY` (the key comes from a Volta-owned Mailchimp user, Account > Extras > API keys). **[Volta account]** Type each value only into wrangler's prompt, never into chat or a file.
- [ ] **5. Remove the development shortcuts.** `npx wrangler secret delete DEV_MODE` and `npx wrangler secret delete EXTRA_ALLOWED_EMAILS`. With `DEV_MODE` on, a personal email could sign in and receive test emails. Also make sure `MAILCHIMP_DRY_RUN` is not set and `ALLOWED_REDIRECT_URIS` is empty.
- [ ] **6. Optional: set `EDITOR_EMAILS`** so team highlights can be told apart from Bader's own notes: `npx wrangler secret put EDITOR_EMAILS`, then enter Bader's exact Volta sign-in address (separate several editors with commas). If it is not set, everyone counts as the editor. If it is set and Bader's address is missing or misspelled, he is treated as team and cannot change entries marked as the editor's.
- [ ] **7. Run the handoff check.** `npm run handoff:check -- https://<worker-url>` (needs `npx wrangler login` on the Volta account). Fix every FAIL line before going on. Warnings are worth reading.
- [ ] **8. Build the Skill zip.** `npm run skill:zip` (Windows PowerShell). It writes `dist/volta-newsletter-skill.zip`. On another system, zip the `skill/volta-newsletter` folder so the archive contains `volta-newsletter/SKILL.md`. Copy the zip to Bader's device.

## Google sign-in: what is known and what is not

Known (from `HANDOFF.md`, `KNOWN-ISSUES.md` and `src/auth/access.ts`):
- The development Google project is in Test mode: only listed test users can sign in, and each authorization expires after 7 days. It is not usable for Bader.
- The fix is a Google Cloud project inside Volta's organization with the consent screen set to **Internal** (only `@voltaeffect.com` accounts, no test users, no 7-day expiry, no verification), and an OAuth client of type Web application with the redirect address `https://<worker-url>/callback`. A Volta Workspace admin has to create it. **[Volta account]**
- The server lets in only a Google account that Google says is verified and whose Workspace domain is `voltaeffect.com`.

Unverified:
- Whether `@voltaeffect.com` addresses are Google Workspace accounts. This was an open question. If they are not, sign-in as built will not work for Bader, and that must be settled before anything else.
- Whether Volta has a Workspace admin who can create the project.
- Sign-in has not been tested against an Internal project. Treat the test sign-in in Part 2 as the first real check.

## Part 2: On Bader's device (about 30 minutes)

Menu names below come from `HANDOFF.md` and may have changed in Claude.

- [ ] **1. Sign in to Claude with Bader's own Claude account.** Check his plan allows custom connectors (on a free plan only one is allowed; on a team plan an owner adds it for the organization). Who pays for Bader's plan is unverified.
- [ ] **2. Add the connector.** Claude > Customize > Connectors > add a custom connector with `https://<worker-url>/mcp`. Bader signs in with his Volta Google account.
- [ ] **3. Install the Skill.** Upload `volta-newsletter-skill.zip` in Claude's Skills settings.
- [ ] **4. Check the connection.** Ask Claude "Who am I on the Volta Newsletter connector?" (it uses `whoami`), then "Which tools does the connector have?". Look for the newer tools: `vet_updates`, `do_not_feature_add`, `do_not_feature_list`, `do_not_feature_remove`, `idea_check`, `idea_record`, `idea_list`. If any are missing, disconnect and reconnect the connector (Claude reads the tool list only when it connects).
- [ ] **4b. Allow the connector's tools.** In Claude's connector settings, set the tool permissions for the Volta Newsletter connector to "Always allow" (or approve each tool the first time it asks). A tool that has not been allowed cannot run when nobody is at the keyboard, and a scheduled run then fails with "No approval received" on that tool. That message comes from Claude's permission system, not from our server. Tools added later (for example `vet_updates`) start out not allowed, so recheck this after any update. Then use "Run now" on the scheduled task once and approve anything it still asks about.
- [ ] **5. Enter the real do-not-feature list.** Ask Bader who has asked not to be named anywhere, and add each through Claude with a note of who asked and when. Do not enter the test-pack names (Tidewater Maps, Brightlane Co); they are made up.
- [ ] **6. Do one practice run.** Ask Claude to start the newsletter for a real date. Use an edition with no founder story, or leave the story out, so nobody's consent is pretended. Check the in-and-out list, answer one question, look at the preview, send a test email to Bader's own address, create the draft, open it in Mailchimp and confirm nothing was sent. Then delete the practice draft and edition (`delete_draft`, then `delete_edition`; Claude asks Bader to confirm each).
- [ ] **7. Create the scheduled task** (next section).
- [ ] **8. Give Bader the six weekly steps** (`README.md`, "What Bader does each week") and the owner and backup names from `HANDOFF.md`.
- [ ] **9. Team highlights.** Ask Matt, Laura and Amy to add the connector in their own Claude, each signing in with their own Volta account, and to say "add this to the newsletter backlog: ..." with a link. The connector alone should be enough; installing the Skill is optional. Unverified: try it once with one of them.

## The scheduled task

Create it in Claude on Bader's device, under his account (it cannot be created for him from elsewhere).

Suggested name: `Volta newsletter run`. Suggested prompt (paste as written):

```text
Run the Volta newsletter flow using the volta-newsletter Skill and the Volta Newsletter connector.
Work from the date of the last issue (list_past_campaigns), not from a fixed schedule.
Gather the sources, vet them with vet_updates, do the double-check the Skill describes, run idea_check on one idea, and build one full draft with save_edition.
Nobody is here to say yes, so do not mark any consent, do not call create_draft or idea_record, do not change the do-not-feature list, and do not publish or delete anything.
Finish with: what is in and out with plain reasons, a list of yes/no questions for Bader, the preview, and a short summary of the last issue's results.
```

**Frequency.** The plan is a weekly run (for example Monday morning). The flow works from the last issue's date, so any rhythm works; Bader has said he sends monthly, so choose with him. A run that finds an unfinished edition continues it rather than starting another.

**Changing it later.** Open the task where you created it and edit its schedule. Asking Claude to change the schedule may also work. Both are unverified; confirm on Bader's device.

**Unverified, check during setup:**
- Where scheduled tasks live in the version of Claude on Bader's device.
- Whether a task runs while the computer is asleep or Claude is closed. Assume it does not until you have tested it.
- Where the finished run shows up, and that Bader can find it. Use the task's "run now" option once and confirm.

## Afterward

- After any deploy that adds or changes tools, disconnect and reconnect the connector in Claude.
- Day-to-day operations (offboarding, rotating keys, backups, logs) are in `HANDOFF.md`.
