# Handoff: running this in production at Volta

This server was built and tested on the developer's personal accounts (a personal Cloudflare account, a Google Cloud project in Test mode, a sandbox Mailchimp account). Before Volta relies on it, work through this list. `npm run handoff:check -- <worker-url>` automates the configuration checks and tells you what is still wrong.

**Read first:** the *Security limits* section at the bottom, and `KNOWN-ISSUES.md`.

## 1. Decide who owns it
- [ ] Name an **owner** and a **backup owner** at Volta. Nothing in this system works without someone who can (a) sign in to the Cloudflare account, (b) manage Volta's Google Workspace, and (c) rotate the Mailchimp key. Write their names here: `Owner: ________  Backup: ________`.
- [ ] Both should read this file and `README.md`, and run the tests once (`npm ci`, `npm test`).

## 2. Cloudflare (hosting and data)
- [ ] Create or choose a **Volta-owned Cloudflare account** (a shared address such as `it@voltaeffect.com`, not a person's personal email). Add the owner and backup as members. No credit card is needed for the free plan.
- [ ] Deploy there: `npx wrangler login`, then `npx wrangler kv namespace create OAUTH_KV`, put the new id into `wrangler.jsonc`, and `npx wrangler deploy`. Note the new `*.workers.dev` URL (or attach a Volta domain).
- [ ] Data does **not** move automatically. Editions, the founder backlog and template history live in the old account's KV. Either start fresh, or run `npm run backup` against the old account first and ask the developer to restore the data.
- [ ] Understand the free plan: 100,000 requests a day is far beyond this use. If requests ever fail with "Worker exceeded resource limits" (error 1102), upgrade to the $5 Workers plan.

## 3. Google sign-in (who may use it)
- [ ] A Volta **Workspace admin** creates a new Google Cloud project **inside Volta's organization**.
- [ ] Set the OAuth consent screen to **Internal** (only `@voltaeffect.com` accounts; no test users, no 7-day expiry, no verification).
- [ ] Create an OAuth client of type *Web application*. Authorized redirect URI: `https://<worker-url>/callback`.
- [ ] Set the secrets on the Worker: `npx wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- [ ] Confirm `ALLOWED_EMAIL_DOMAIN` in `wrangler.jsonc` is `voltaeffect.com`. Everyone with a verified Volta Google account can then use the tools; access ends when Volta suspends the account (see *Offboarding*).

## 4. Remove every development shortcut (important)
- [ ] `npx wrangler secret delete DEV_MODE` and `npx wrangler secret delete EXTRA_ALLOWED_EMAILS`. With `DEV_MODE` set, a personal email in `EXTRA_ALLOWED_EMAILS` can sign in and receive test emails, bypassing the Volta-only rule. In production neither may exist.
- [ ] Make sure `MAILCHIMP_DRY_RUN` is not set, and `ALLOWED_REDIRECT_URIS` is empty (only Claude's real callback addresses may connect).
- [ ] Run `npm run handoff:check -- https://<worker-url>`. Every FAIL line must be fixed before go-live.

## 5. Mailchimp
- [ ] Use **Volta's real Mailchimp account and audience**, not the developer's sandbox. Create the API key from a Volta-owned Mailchimp user (Account > Extras > API keys) and set it: `npx wrangler secret put MAILCHIMP_API_KEY`. **Rotate or delete the development key** in the old account.
- [ ] The first `get_template` call creates a template named "Volta Newsletter Shell" in that account and stores its id. Confirm it appears under Content > Email templates. Design changes are made by asking Claude; edits made directly in Mailchimp's template editor are invisible to this server and get overwritten.
- [ ] Check the plan. On Mailchimp's **Free** plan the footer must include the `*|REWARDS|*` badge (the shell has it); a paid plan removes that requirement.
- [ ] Fix audience defaults so the footer and sender are right: company/sender name (the footer currently shows "N/A" from the audience settings), default From name, reply-to address and the physical mailing address.
- [ ] Set up sender authentication (SPF/DKIM for the From address) so mail is not marked as spam.
- [ ] Confirm Volta's own basis for emailing the list under Canada's anti-spam law (CASL). This tool does not manage subscriber consent.

## 6. Claude
- [ ] Add the connector: Claude > Customize > Connectors > add a custom connector with `https://<worker-url>/mcp`, then sign in with a Volta Google account. On Team/Enterprise plans an owner adds it for the organization. On a Free Claude plan only one custom connector is allowed.
- [ ] Install the Skill: `npm run skill:zip`, then upload `dist/volta-newsletter-skill.zip` in Claude's Skills settings (or zip `skill/volta-newsletter` so the archive holds `volta-newsletter/SKILL.md`).
- [ ] Walk the editor through one full run on production: start an edition, research a founder, preview, send a test, create the draft, open it in Mailchimp.
- [ ] Tell users: after any deploy that changes tools, disconnect and reconnect the connector in Claude (Claude reads the tool list only when it connects).

## Operations runbook

**Add a user.** Nothing to do: anyone with a verified `@voltaeffect.com` Google account can sign in.

**Offboarding (someone leaves, or a device is lost).**
1. Suspend their Google Workspace account. This stops *new* sign-ins immediately.
2. Their existing Claude session keeps working until it expires (up to 30 days) unless you cut it: `npm run revoke:sessions` shows what would be deleted; add `--confirm` to sign **everyone** out (people simply sign in again), or `--user-id <id>` for one person (the id is the second part of a `grant:<id>:...` key in the preview).

**Rotate the Mailchimp key.** Create a new key in Mailchimp, `npx wrangler secret put MAILCHIMP_API_KEY`, delete the old key in Mailchimp. Do this whenever someone with the key leaves.

**Rotate the Google client secret.** Create a new secret in Google Cloud, `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then disable the old one.

**Change the newsletter's look.** Ask Claude (it uses `get_template` / `update_template`, keeps the last 10 versions, and can undo with `restore_template`).

**Back up the data.** `npm run backup` writes `backups/kv-<date>.json` (editions, backlog, template history; gitignored because it holds founder notes). Cloudflare KV has no automatic backup, so run it before risky changes and now and then.

**Deploy a change safely.** `npm test`, then `npm run e2e` and `npm run live:drafts` (both against a *sandbox* Mailchimp account; they only create and delete drafts), then `npx wrangler deploy`, then reconnect the connector in Claude.

**Read the logs.** Workers Logs keeps 3 days on the free plan (Cloudflare dashboard > Workers > this Worker > Logs, or `npx wrangler tail`). Logs hold who did what (tool name, edition id, outcome); never email bodies, keys or tokens. For longer history add a D1 audit table.

## Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| Claude says a tool doesn't exist | Reconnect the connector (Customize > Connectors). |
| "Access denied" at sign-in | The account is not a verified Volta Workspace account, or `ALLOWED_EMAIL_DOMAIN` is wrong. |
| "Connection not allowed" at sign-in | The redirect address is not Claude's. Only add addresses to `ALLOWED_REDIRECT_URIS` if you understand why. |
| `create_draft` refuses | A featured story lacks confirmed consent (working as intended), the edition lacks subject/preview text/body, or the draft already exists (needs `overwrite`). |
| Test email refused | The address is not at `@voltaeffect.com`; any bad address refuses the whole request. |
| "Too many ... requests" | Hourly per-person limit; wait, and check for a loop. |
| Mailchimp errors mentioning the footer | The `*|UNSUB|*`, address or (free plan) `*|REWARDS|*` tags are missing from the template. |
| Everything fails with "Worker exceeded resource limits" | Free-plan CPU limit; upgrade to the $5 plan. |

## Security limits to understand
- **Consent is the editor's word.** The server records who agreed and how, and blocks drafts without it, but cannot verify it. Volta's editor is responsible for genuine consent.
- **Anyone at Volta with a Google account can use the tools**, and all users see all editions and backlog notes. Everything is logged.
- **The Mailchimp API key has full power over that account** (Mailchimp keys cannot be limited). It lives only in a Worker secret. Anyone who can deploy or read secrets in the Cloudflare account can use it, so keep that account's membership small.
- **Claude reads untrusted web pages** while researching and could be tricked by text in them. The design limits the damage: nothing can be sent to subscribers, drafts need consent, test emails only reach Volta addresses, risky tools are rate limited, and template changes can be undone. The editor still reads everything before sending.
- **Sessions outlast account suspension** for up to 30 days unless revoked (see Offboarding).
- The HTML checks stop accidents and obvious abuse; they are not a complete sanitizer. Email clients strip most active content anyway.
- Editions and the backlog are last-write-wins; two people editing the same thing at the same instant can overwrite each other.
