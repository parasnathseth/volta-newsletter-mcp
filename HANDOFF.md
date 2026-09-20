# Handoff checklist: moving this to Volta for production use

Keep this list updated as the build progresses. Everything below is work that has to happen on Volta's side (or with Volta's accounts) before this runs in production, because during development it runs on the developer's personal accounts.

## 1. Accounts and ownership
- [ ] Decide who owns this long term (name a person and a backup). Without that, nobody will know how to change access or rotate keys in 7 months.
- [ ] Create or choose a **Volta-owned Cloudflare account** (a shared or org email, not a personal one) and add at least two Volta admins. Deploy the Worker there (or transfer it).
- [ ] Choose the public URL: the free `*.workers.dev` subdomain, or a Volta custom domain (optional).

## 2. Google sign-in (OAuth)
- [ ] Create a **new Google Cloud project inside Volta's Workspace organization** (created by a Workspace admin).
- [ ] Configure the OAuth consent screen as **Internal** (no test users, no 7-day expiry, no verification).
- [ ] Create an OAuth client (Web application). Redirect URI = the production Worker URL's callback path.
- [ ] Put the new client ID/secret into Worker secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and generate a fresh `COOKIE_ENCRYPTION_KEY`.
- [ ] **Delete the dev-only `EXTRA_ALLOWED_EMAILS` secret** so only `@voltaeffect.com` accounts can sign in.
- [ ] Confirm the allowed domain setting is `voltaeffect.com`. Decide whether domain-wide access is acceptable or whether to add a managed allowlist.
- [ ] Decide the refresh-token lifetime (how often Bader has to sign in again).

## 3. Mailchimp
- [ ] Use **Volta's real Mailchimp account and audience** (not the developer's sandbox).
- [ ] Generate a new API key from a Volta-owned Mailchimp user; store it only as the `MAILCHIMP_API_KEY` Worker secret. **Rotate/delete the development key.**
- [ ] Check the plan tier. On the Free plan the footer must include the `*|REWARDS|*` badge; a paid plan removes it (then remove that line from the shell).
- [ ] Fix audience defaults: sender name/company (the footer currently shows "N/A" from the audience settings), default From name and reply-to, physical mailing address.
- [ ] Set up sender/domain authentication (SPF/DKIM) for the From address so mail is not marked as spam.
- [ ] The shell template seeds itself: the first `get_template` call creates "Volta Newsletter Shell" in Volta's Mailchimp account (or reuses one with that name) and stores its ID in KV. Confirm it appears in Mailchimp and its `body` region is detected. Note: Mailchimp never returns template HTML through the API, so the copy in KV is the source of truth. Edits made directly in Mailchimp's template editor are not seen by the server; make design changes by asking Claude.
- [ ] Confirm consent basis for the subscriber list (CASL/Canadian anti-spam law) with Volta's own process.

## 4. Claude side
- [ ] Add the connector in Claude (Customize > Connectors > custom connector, using the production `/mcp` URL). On Team/Enterprise an owner adds it for the organization. Free Claude plans allow only one custom connector.
- [ ] Install/upload the Skill (`skill/SKILL.md`) for Bader and confirm it is picked up.
- [ ] Walk Bader through one full run (start an edition, research, preview, send test, push draft) on the production setup.

## 5. Configuration and operations
- [ ] Set `TEST_EMAIL_ALLOWED_DOMAINS` (default `voltaeffect.com`).
- [ ] Confirm the calendar feed URL is the one Volta wants (default `https://calendar.voltaeffect.com/api/calendar/ics`).
- [ ] Decide on log retention: Workers Logs keeps 3 days on the free plan; add a D1 audit table if Volta wants longer.
- [ ] Note usage limits (Workers free plan 10 ms CPU per request; upgrade to the $5 plan if the events tool hits it).
- [ ] Start with fresh KV data in production (editions, template versions, founder backlog); decide whether any backlog notes should be copied over.
- [ ] Remove any developer-only test data, secrets and test users; run a final check of `wrangler secret list`.

## 6. Documentation to give Volta
- [ ] How to add/remove a user (Google Workspace account management, or the allowlist if added later).
- [ ] How to rotate the Mailchimp key and Google client secret.
- [ ] How to change the template (ask Claude) and how to undo (restore a previous version).
- [ ] Known limitations from the plan's security section (consent is an attestation, artifact share links are public, prompt-injection risk from web research).
