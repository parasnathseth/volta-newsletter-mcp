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
| Editions | `save_edition`, `get_edition`, `list_editions`, `render_edition` |
| Mailchimp | `create_draft`, `send_test`, `delete_draft`, `get_report`, `list_past_campaigns` |
| Template | `get_template`, `update_template`, `list_template_versions`, `restore_template` |
| Founder backlog | `backlog_add`, `backlog_list`, `backlog_update`, `backlog_remove` |

Safety rules built into the server: draft-only (no send tool); a Mailchimp draft cannot be created unless **every featured story has confirmed consent** (consent is per story and resets if the story's topic or founder changes); test emails can only go to `@voltaeffect.com`; re-pushing a draft needs explicit `overwrite`; sign-in is limited to verified Volta Google Workspace accounts.

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
```

`npm run e2e` and `npm run live:drafts` need `MAILCHIMP_API_KEY` in `.dev.vars` and use a **sandbox** Mailchimp account. They only create drafts and a throwaway template, then delete them, and never send to any inbox.

## Deploying

```bash
npx wrangler login        # once, opens a browser
npx wrangler deploy
```

Secrets live in Cloudflare (`npx wrangler secret put <NAME>`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `MAILCHIMP_API_KEY`, and for development only `EXTRA_ALLOWED_EMAILS`. Plain settings are in `wrangler.jsonc`. After a deploy that adds or changes tools, **disconnect and reconnect** the connector in Claude so it reloads the tool list.

## Connecting Claude

1. In Claude: Customize > Connectors > add a custom connector with the Worker URL ending in `/mcp`, then sign in with a Volta Google account.
2. Build the Skill zip with `npm run skill:zip` (Windows/PowerShell) and upload `dist/volta-newsletter-skill.zip` in Claude's Skills settings, or zip the `skill/volta-newsletter` folder yourself so the archive contains `volta-newsletter/SKILL.md`.

See `HANDOFF.md` before using this in production.
