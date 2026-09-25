# Volta Newsletter assistant

An AI helper that gathers what happened at Volta, checks it, and prepares the community newsletter as a **Mailchimp draft**. It has two parts: a small server (Cloudflare Workers) that holds the rules, and instructions (a "Skill") that tell your AI app how to run the weekly routine. **Nothing is ever sent to subscribers from here.** The editor reads the draft in Mailchimp and clicks send.

## What the editor does each week

The routine starts on a schedule, or when the editor says "start the newsletter". The AI gathers the calendar, the Volta blog and residency page, AI news since the last issue, the backlog and anything pasted in, then checks it all. After that:

1. **Read what is in and what is out**, with a plain reason for each.
2. **Answer a few yes/no questions** (for example "Do you have Jane's OK to share this?").
3. **Read the full draft** and ask for changes in plain words.
4. **Say yes.** The AI creates the Mailchimp draft.
5. **Open Mailchimp, read it, edit if you like, and send it yourself.**

Each issue has four sections: **Volta Community Wins**, **Coming up**, **The Latest AI News**, and **A Startup Idea to Think About** with the AI Residency call to action. Every item links to its source.

## What it protects against

- **Nothing is sent.** There is no send tool, only "create a draft".
- **No founder without their OK.** Consent is recorded per story, and a draft can't be created until it is.
- **Nobody on the do-not-feature list is named.**
- **Every item has a source** (a link, or a note for a story the founder told you directly).
- **Hidden instructions in what the AI reads can't change what is featured.** They are removed and reported.
- **Two layers of checking.** The server applies fixed rules; the AI double-checks what a server can't (it opens the links). The stricter answer wins, and the AI can only tighten a decision.

These are checks, not guarantees. Consent is still the editor's word, and the editor reads every draft. `docs/HOW-IT-WORKS.md` lists each check and its limits.

## How it fits together

```
Your AI app (Claude, ChatGPT or Cursor)  -->  this server (Cloudflare)  -->  Mailchimp (drafts only)
   follows the Skill's instructions            holds the rules and data      Google sign-in for staff
```

## Set it up (one time, about 30 minutes)

You need: a **Cloudflare** account (free), a **Google Workspace** account that can create a Cloud project, a **Mailchimp** account with an API key, **Node.js 20+** and **git**, and an account with the AI app you will use.

### 1. Get the code and deploy the server
```bash
git clone https://github.com/parasnathseth/volta-newsletter-mcp.git
cd volta-newsletter-mcp
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # copy the id it prints into wrangler.jsonc (kv_namespaces)
```
In `wrangler.jsonc` set `ALLOWED_EMAIL_DOMAIN` and `TEST_EMAIL_ALLOWED_DOMAINS` to your organisation's email domain (they say `voltaeffect.com`). Then:
```bash
npx wrangler deploy      # prints your address: https://<name>.<account>.workers.dev
```
Call that address `<worker-url>` below.

### 2. Google sign-in (who may use it)
In Google Cloud, create a project inside your organisation. Set the OAuth consent screen to **Internal**, then create an OAuth client of type **Web application** with the redirect address `https://<worker-url>/callback`. Then store its keys (type each value into the prompt, never into chat or a file):
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 3. Mailchimp
Create an API key (Account > Extras > API keys), then:
```bash
npx wrangler secret put MAILCHIMP_API_KEY
```
Set the audience's From name, reply-to and mailing address in Mailchimp so the footer is right.

### 4. Check it
```bash
npm run handoff:check -- https://<worker-url>
```
Fix every FAIL line. (`DEV_MODE` and `EXTRA_ALLOWED_EMAILS` are development shortcuts and must not be set in production.)

### 5. Connect your AI app
Pick **one** of the sections below. Only Claude has been tested end to end.

#### Claude (tested)
1. In Claude, go to **Customize > Connectors** and add a custom connector with `https://<worker-url>/mcp`. Sign in with a work Google account.
2. Build the instructions: `npm run skill:zip`, then upload `dist/volta-newsletter-skill.zip` in Claude's **Skills** settings.
3. Set the connector's tool permissions to **Always allow**, so scheduled runs aren't blocked ("No approval received").
4. Ask Claude "Who am I on the Volta Newsletter connector?", then "Which tools does the connector have?". If tools are missing, disconnect and reconnect the connector.
5. **Optional, Claude Code (the terminal app):** it signs in through a fixed local address. Add `http://localhost:8080/callback` to `ALLOWED_REDIRECT_URIS` (see "Other AI apps" below), then run `claude mcp add --transport http --callback-port 8080 volta-newsletter https://<worker-url>/mcp` and sign in with `/mcp`. Not tested.

#### ChatGPT (not tested)
1. You need a plan that allows custom connectors (Pro, Team, Enterprise or Edu). Turn on **Settings > Connectors > Advanced > Developer mode**.
2. Add the callback address ChatGPT uses to the server (see "Other AI apps" below). It is commonly reported as `https://chatgpt.com/connector_platform_oauth_redirect`; check what ChatGPT shows you.
3. In Connectors, **Create** a connector: URL `https://<worker-url>/mcp`, authentication **OAuth**. Sign in with a work Google account.
4. ChatGPT has no Skills. Run `npm run instructions`, then paste `dist/volta-newsletter-instructions.md` into a Project's instructions (or upload it as a project file) and use that Project for the newsletter. Long instructions may be cut off; if so, paste `skill/volta-newsletter/SKILL.md` and `workflow.md` first.
5. Choose the connector in each new chat (**+ > Developer mode**).

#### Cursor (not tested)
1. In your project folder, create `.cursor/mcp.json` (or use `~/.cursor/mcp.json` for all projects):
   ```json
   {
     "mcpServers": {
       "volta-newsletter": { "url": "https://<worker-url>/mcp" }
     }
   }
   ```
2. Add Cursor's sign-in address to the server (see "Other AI apps"): `http://localhost:8787/callback` for the desktop app, and `https://www.cursor.com/agents/mcp/oauth/callback` if you also use Cursor on the web or its cloud agents. Older Cursor versions used `cursor://anysphere.cursor-mcp/oauth/callback`; if sign-in is refused, check which address was rejected (see below).
3. Open Cursor's MCP settings (**Settings > Tools & MCP**). The Volta server shows a connect or sign-in prompt: approve it and sign in with a work Google account.
4. Open this project folder in Cursor. It reads `AGENTS.md` in the project root, which points it to the instructions in `skill/volta-newsletter/`. Then ask it to "start the newsletter".

#### Other AI apps (needed for ChatGPT, Cursor and Claude Code)
The server only accepts sign-ins from Claude's own addresses, so nobody can register a look-alike app and steal a login. To allow another app, add its exact callback address under `vars` in `wrangler.jsonc`, comma separated, then redeploy:
```jsonc
"ALLOWED_REDIRECT_URIS": "https://chatgpt.com/connector_platform_oauth_redirect,http://localhost:8787/callback"
```
Each address you add widens who can sign in, so add only what you use. `handoff:check` will flag the setting on purpose. If sign-in is refused, the log shows `auth.redirect_denied` with the host that was rejected (`npx wrangler tail`).

### 6. Set up the weekly run and try it
Ask your AI app to "start the newsletter" once and check the in-and-out list, the draft, a test email to yourself, and the Mailchimp draft (nothing should be sent). Then schedule it. In Claude, create a scheduled task (for example Monday morning) with the prompt in `SETUP.md`. Add your real do-not-feature list by asking the AI to add each name.

## What is built, and what is not

**Built:** live calendar events; per-story consent and source links; server-side vetting plus the AI double-check; the do-not-feature list; AI news rules; the startup idea checker; the founder backlog; test emails and Mailchimp drafts; analytics; template editing with undo.

**Not built or not tested:** ChatGPT and Cursor connections (documented above, untested); Slack or Gmail connections; our own scheduler; a no-server version. The `v3` git tag is the earlier version.

## Help

- `SETUP.md`: the scheduled-task prompt and a longer first-day checklist.
- `HANDOFF.md`: who must own what to run this for real, day-to-day operations and troubleshooting.
- `docs/HOW-IT-WORKS.md`: how each check works, for anyone who has to explain it.
- `KNOWN-ISSUES.md`: limits. `CLAUDE.md`: notes for anyone changing the code.

Tests (no accounts needed): `npm test`, and `npm run demo:vet` to see the checks sort 24 made-up updates. `npm run e2e` needs a **sandbox** Mailchimp key in `.dev.vars` (copy `.dev.vars.example`); never run it on a real account.
