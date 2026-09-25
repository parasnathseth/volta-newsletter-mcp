# Volta Newsletter assistant

An AI helper that gathers what happened at Volta, checks it, and prepares the community newsletter as a **Mailchimp draft**. It has two parts: a small server that holds the rules, and instructions (a "Skill") that tell Claude how to run the weekly routine. **Nothing is ever sent to subscribers from here.** The editor reads the draft in Mailchimp and clicks send.

## Contents

- [What the editor does each week](#what-the-editor-does-each-week)
- [What it protects against](#what-it-protects-against)
- [How it fits together](#how-it-fits-together)
- [Get started on your machine](#get-started-on-your-machine)
- [Appendix A: Set up the server (one time)](#appendix-a-set-up-the-server-one-time)
- [Appendix B: ChatGPT and other AI apps](#appendix-b-chatgpt-and-other-ai-apps)

## What the editor does each week

The routine starts on a schedule, or when the editor says "start the newsletter". Claude gathers the calendar, the Volta blog and residency page, AI news, the backlog and anything pasted in, then checks it all. After that:

1. **Read what is in and what is out**, with a plain reason for each.
2. **Answer a few yes/no questions** (for example "Do you have Jane's OK to share this?").
3. **Read the full draft** and ask for changes in plain words.
4. **Say yes.** Claude creates the Mailchimp draft.
5. **Open Mailchimp, read it, edit if you like, and send it yourself.**

Each issue has four sections: **Volta Community Wins**, **Coming up**, **The Latest AI News**, and **A Startup Idea to Think About** with the AI Residency call to action. Every item links to its source.

## What it protects against

- **Nothing is sent.** There is no send tool, only "create a draft".
- **No founder without their OK.** Consent is recorded per story, and a draft can't be created until it is.
- **Nobody on the do-not-feature list is named.**
- **Every item has a source** (a link, or a note for a story the founder told you directly).
- **Hidden instructions in what Claude reads can't change what is featured.** They are removed and reported.
- **Two layers of checking.** The server applies fixed rules; Claude double-checks what a server can't (it opens the links). The stricter answer wins, and Claude can only tighten a decision.

These are checks, not guarantees. Consent is still the editor's word, and the editor reads every draft. See `docs/HOW-IT-WORKS.md` for each check and its limits.

## How it fits together

```
Claude  -->  the server (Cloudflare)  -->  Mailchimp (drafts only)
follows the Skill's instructions          holds the rules and data     Google sign-in for staff
```

## Get started on your machine

This assumes the server is already set up (if not, see [Appendix A](#appendix-a-set-up-the-server-one-time)) and you have its address, called `<worker-url>` below. You need a Claude account whose plan allows custom connectors.

**Testing?** If the server's Google sign-in is in test mode, ask the owner to add your email to the Google OAuth test users before you sign in.

### 1. Add the connector
In Claude, go to **Customize > Connectors**, add a custom connector with `https://<worker-url>/mcp`, and sign in with your Google account.

### 2. Add the Skill
Build the file with `npm run skill:zip` (or use the copy you were given: `volta-newsletter-skill.zip`). In Claude, go to the **Skills** settings and upload it.

### 3. Allow the connector's tools
In the connector's settings, set tool permissions to **Always allow**. Otherwise a scheduled run stops with "No approval received".

Check it worked: ask Claude "Who am I on the Volta Newsletter connector?", then "Which tools does the connector have?". If tools are missing, disconnect and reconnect the connector.

### 4. Add the scheduled task
Create a scheduled task in Claude (for example every Monday morning) and paste this prompt:

```text
Use the Volta Newsletter skill and its connector to prepare this week's newsletter, following the skill's weekly flow and its rules for scheduled runs. Nobody is here to answer questions, so do not stop to ask anything.

Today's date is the newsletter date. Use the next 14 days for events unless told otherwise.

Always create a brand-new edition for this run. Never save to, change, create a draft from or delete any existing edition.

Do the full run: check the do-not-feature list, pull events, read the Volta blog and the AI Residency page, find AI news since the last issue (open the newsroom pages directly, and one good item is enough), read the backlog, vet everything, do the double-check, choose one startup idea and run it through the idea check, then save one full draft edition and render the preview.

Do not: mark consent, create a Mailchimp draft, record an idea, change the do-not-feature list, publish anything, or delete anything. Leave those for the editor.

Finish with a short message for the editor in plain language: what is in the draft and what was left out (with reasons), the few yes/no questions I need answered (consent for any founder story, whether to use the idea, and if there is no founder story, whether they have someone to feature), and the preview. If a section could not be built, say which one and why.
```

### 5. Click "Run now"
Run the task once and approve anything it still asks about. When it finishes you should see what is in the draft and what was left out, a few yes/no questions, and a preview. Nothing is sent, and no Mailchimp draft is created until you say yes.

Then try it by hand: ask Claude to "start the newsletter", answer a question, ask for a change, and say yes to create the Mailchimp draft. To add people who must never be named, ask Claude to add them to the do-not-feature list.

## Appendix A: Set up the server (one time)

For the owner. You need a Cloudflare account (free), a Google Workspace account that can create a Cloud project, a Mailchimp account with an API key, Node.js 20+ and git.

1. **Get the code and deploy.**
   ```bash
   git clone https://github.com/parasnathseth/volta-newsletter-mcp.git
   cd volta-newsletter-mcp
   npm install
   npx wrangler login
   npx wrangler kv namespace create OAUTH_KV     # copy the id it prints into wrangler.jsonc (kv_namespaces)
   ```
   In `wrangler.jsonc` set `ALLOWED_EMAIL_DOMAIN` and `TEST_EMAIL_ALLOWED_DOMAINS` to your organisation's email domain, then `npx wrangler deploy`. It prints your address, `https://<name>.<account>.workers.dev`.
2. **Google sign-in.** In Google Cloud, create a project inside your organisation, set the OAuth consent screen to **Internal**, and create an OAuth client of type **Web application** with the redirect address `https://<worker-url>/callback`. Store its keys (type each value at the prompt, never into chat or a file):
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
3. **Mailchimp.** Create an API key (Account > Extras > API keys), then `npx wrangler secret put MAILCHIMP_API_KEY`. Set the audience's From name, reply-to and mailing address in Mailchimp.
4. **Check it.** `npm run handoff:check -- https://<worker-url>` and fix every FAIL line. (`DEV_MODE` and `EXTRA_ALLOWED_EMAILS` are development shortcuts and must not be set in production.)

Try the checks with no accounts at all: `npm test`, and `npm run demo:vet` to see them sort 24 made-up updates. `npm run e2e` needs a **sandbox** Mailchimp key in `.dev.vars`; never run it on a real account.

## Appendix B: ChatGPT and other AI apps

Only Claude has been tested end to end. These steps come from the vendors' documentation and are untested.

**The server setting.** The server only accepts sign-ins from Claude's own addresses, so nobody can register a look-alike app and steal a login. To allow another app, add its exact callback address under `vars` in `wrangler.jsonc`, comma separated, then redeploy:
```jsonc
"ALLOWED_REDIRECT_URIS": "https://chatgpt.com/connector_platform_oauth_redirect"
```
Each address you add widens who can sign in, so add only what you use. `handoff:check` will warn about the setting on purpose. If sign-in is refused, the log shows `auth.redirect_denied` with the host that was rejected (`npx wrangler tail`).

**ChatGPT.**
1. You need a plan that allows custom connectors (Pro, Team, Enterprise or Edu). Turn on **Settings > Connectors > Advanced > Developer mode**.
2. Add the callback address above (it is commonly reported as shown; check what ChatGPT displays).
3. In Connectors, **Create** a connector: URL `https://<worker-url>/mcp`, authentication **OAuth**. Sign in with your Google account.
4. ChatGPT has no Skills. Run `npm run instructions`, then paste `dist/volta-newsletter-instructions.md` into a Project's instructions (or upload it as a project file) and use that Project. If it is too long, paste `skill/volta-newsletter/SKILL.md` and `workflow.md` first.
5. Choose the connector in each new chat (**+ > Developer mode**).

**Claude Code (terminal app).** It signs in through a fixed local address: add `http://localhost:8080/callback` to `ALLOWED_REDIRECT_URIS`, run `claude mcp add --transport http --callback-port 8080 volta-newsletter https://<worker-url>/mcp`, then sign in with `/mcp`.
