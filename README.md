# Volta Newsletter MCP server

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that lets Claude help Volta's newsletter editor plan, write, preview, test and prepare the community newsletter as a **Mailchimp draft**. The editor chats with Claude; Claude uses this server's tools. Nothing is ever sent to subscribers from here: the editor reviews and sends from Mailchimp.

```
Editor <-> Claude (+ the volta-newsletter Skill) --MCP over HTTPS + Google OAuth--> this Worker --> Mailchimp API
                                                                                       |--> Volta calendar (.ics)
                                                                                       '--> Cloudflare KV (editions, template history, backlog)
```

## What it can do

| Area | Tools |
|---|---|
| Events | `get_upcoming_events` (real feed, Halifax times, cached) |
| Editions | `save_edition`, `get_edition`, `list_editions`, `render_edition`, `delete_edition` |
| Mailchimp | `create_draft`, `send_test`, `delete_draft`, `get_report`, `list_past_campaigns` |
| Analytics (read-only, aggregate) | `compare_campaigns`, `get_audience_stats`, plus the richer `get_report` |
| Template | `get_template`, `update_template`, `list_template_versions`, `restore_template` |
| Founder backlog | `backlog_add`, `backlog_list`, `backlog_update`, `backlog_remove` |

Safety rules built into the server:
- **Draft-only:** there is no tool that sends to subscribers.
- **Consent gate:** a Mailchimp draft cannot be created unless every featured story has confirmed consent. Consent is per story and resets if the story's topic or founder changes.
- **Volta-only:** sign-in is limited to verified Volta Google Workspace accounts, and only Claude's real OAuth redirect addresses may connect (a look-alike client cannot register). Test emails can only go to `@voltaeffect.com`.
- **Guard rails:** re-pushing a draft needs explicit `overwrite`; HTML is checked for scripts, dangerous tags and unsafe links; risky tools are rate limited per person; ids are validated before they touch storage.

## Project layout

- `src/index.ts` Worker entry: Google OAuth in front of `/mcp`
- `src/server.ts` builds the MCP server and registers every tool
- `src/tools/` tool definitions; `src/lib/` the logic behind them (`ics`, `events`, `edition`, `campaign`, `template`, `backlog`, `render`, `mailchimp`)
- `src/auth/` Google sign-in, consent page, access rule
- `template/shell.html` the email shell (header, footer, one editable `body` region)
- `skill/volta-newsletter/SKILL.md` the instructions Claude follows (upload to Claude)
- `scripts/` unit tests, the live Mailchimp test and the end-to-end harness
- `HANDOFF.md` what Volta must do to run this in production; `KNOWN-ISSUES.md` limitations and lessons

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the values (gitignored)
npm test                         # unit tests, no network
npm run e2e                      # every workflow through the MCP layer, against the real calendar and a Mailchimp sandbox
npm run live:drafts              # create/re-push/delete a real Mailchimp draft, then clean up
npm run smoke                    # quick check of the Mailchimp mechanics this relies on
```

`e2e`, `live:drafts` and `smoke` need `MAILCHIMP_API_KEY` in `.dev.vars` and use a **sandbox** Mailchimp account. They only create drafts and a throwaway template, then delete them (`smoke` sends one test email to the account owner).

Operations scripts (need `npx wrangler login`): `npm run handoff:check -- <worker-url>` (is this deployment production-ready?), `npm run backup` (export KV data), `npm run revoke:sessions` (sign people out), `npm run skill:zip` (package the Skill).

## Deploying

```bash
npx wrangler login        # once, opens a browser
npx wrangler deploy
```

Secrets live in Cloudflare (`npx wrangler secret put <NAME>`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MAILCHIMP_API_KEY`. For development only, `DEV_MODE=true` enables `EXTRA_ALLOWED_EMAILS` (personal emails allowed to sign in and receive test emails); **neither may exist in production**. Plain settings are in `wrangler.jsonc`. After a deploy that adds or changes tools, **disconnect and reconnect** the connector in Claude so it reloads the tool list.

## Connecting Claude

1. In Claude: Customize > Connectors > add a custom connector with the Worker URL ending in `/mcp`, then sign in with a Volta Google account.
2. Build the Skill zip with `npm run skill:zip` (Windows/PowerShell) and upload `dist/volta-newsletter-skill.zip` in Claude's Skills settings, or zip the `skill/volta-newsletter` folder yourself so the archive contains `volta-newsletter/SKILL.md`.

See `HANDOFF.md` before using this in production.
