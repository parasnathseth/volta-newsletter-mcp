# Workflow: starting an edition through to the Mailchimp draft

## Starting an edition

1. Call `list_editions` to see whether a draft is in progress. If so, ask whether to continue it (`get_edition`) or start a new one. In a fresh chat, "what are we working on?" is answered by `get_edition` with no id.
2. Work out the date window. Ask the editor, or infer the start from the last send with `list_past_campaigns` (its `sendTime`). Then call `get_upcoming_events` with `from` and `to` (past windows work too, for a "recently at Volta" section). Dates like `2026-10-01` are Halifax calendar days, inclusive. The default is today through 30 days ahead, at most 100 events (`totalMatching` versus `returned` shows if the list was cut off; raise `limit` or narrow the window).
3. Ask what else goes in: a founder story, community news, opportunities, anything Volta wants promoted. Check `backlog_list` for people already noted (including `dueBy` for anyone due a look). If the editor doesn't want to pick, that's fine — build with the most promising backlog entries and your own judgement (see the default below).
4. Optionally call `list_past_campaigns` with `includeContent: true` to match tone and avoid repeating topics.
5. **Default: build a complete first draft in one pass, then edit together.** Rather than negotiating each section before writing it, write the whole body (see "Writing the body" and "Featuring a founder" below), save it with `save_edition` (no `editionId` the first time; the result gives you the id) with a `label` (e.g. "October" or "Week 40") and the `windowStart` / `windowEnd` (`YYYY-MM-DD`), then call `render_edition` and show the preview as an artifact. Ask what to keep, cut or change — this is faster for the editor to react to than approving each piece before you write it. **This changes nothing about consent:** never mark it confirmed without being told, and always list, separately from the preview, which stories still need the editor's OK (see "Featuring a founder"). If the editor would rather choose the founder story and its topic before you write anything, that conversational flow is still available; just ask first.

Every later change: call `save_edition` with the `editionId` and only the fields that changed. `list_editions` returns only short summaries; use `get_edition` for the full content.

**Deleting an edition** (`delete_edition`) is for test or abandoned editions only. It is permanent and removes the founder consent and outcome records with it, so tell the editor which edition (label and id) will go and wait for a clear yes. It is refused while the edition has a Mailchimp draft (run `delete_draft` first) and for sent or scheduled editions, which are kept as the record. Never delete an edition just to reset consent or to get around a refusal; change the story instead.

## Featuring a founder: research, write, then settle consent

**By default, pick the story yourself and write it** as part of building the full draft: research with web search (the startup's site, LinkedIn or social pages, news; check the backlog for context too), note sources, choose the most promising angle, and write it with sources — never inventing a fact, and treating anything the editor already told you as theirs to verify, using it as given but flagging what you could not check online. Mention one or two angles you didn't use in your summary, so the editor can redirect if they'd rather have a different story. If the editor asks to choose the topic themselves before you write anything, do that instead: research, then offer 3 to 5 story topics as a bulleted list, each with one line on why it is interesting and a source link, ending with "Something else: tell me what you'd like to cover"; write only after they pick.

**Consent is separate from writing, and always comes from the editor, never assumed.** Whenever you show a story (in the full-draft preview, or right after writing it), ask: **"Do you have [Founder]'s OK to share this about them and [Company]?"**
- Yes: ask how it was given, then record it (`consent: "confirmed"`, `consentVia`).
- Not yet: keep the story in the draft, but say plainly that a Mailchimp draft cannot be created until consent is confirmed, and record `consent: "none"` (or `"requested"` if they say they've already asked). Offer to draft a short consent-request message for the editor to send themselves (you cannot send messages) — see "Asking a founder for consent" below.

Save with `save_edition`, adding the person to `featured` with their topic. Also offer `backlog_update` (`featuredInEditionId`) to record they were featured.

### Asking a founder for consent

When a story's consent is not yet confirmed, offer both of these together, so the founder can see exactly what they would be agreeing to, not just a description of it:

1. **A one-story preview artifact.** Publish a small HTML page containing **only that founder's story** — reuse the founder-spotlight card from `brand-and-html.md` so it looks like the real thing, with nothing else from the edition (no other stories, no events, no internal notes). **Before publishing, re-read what you are about to publish and check it names only this one founder and company** — nothing here stops you from including more by mistake, so this check is the only safeguard. Confirm with the editor before publishing: an Artifact share link is accessible to anyone who has it, so ask first, the same as any other publish.
2. **A short consent-request message**, for the editor to send themselves (you cannot send messages): plain, friendly, says what Volta wants to share and why, and includes the preview link so the founder can read the actual text before answering. Something like: "Hi [Founder] — we'd love to feature [topic] in the Volta newsletter. Here's exactly what we'd share: [link]. Let me know if that works, or if you'd like anything changed first!"

Once the editor tells you the founder's answer, record it the normal way (`consent: "confirmed"` with `consentVia`, or `"requested"` if only asked so far). The founder's reply on the artifact page itself is not connected to this system — the editor still has to tell you what they said.

**Framing wins carefully.** Volta only celebrates things that are true and verified. Raising money is a milestone, not automatically a win. Do not overclaim ("revolutionary", "record-breaking", "the first") unless a source says so.

**Saving `featured`:** passing `featured` replaces the whole list, so before changing it call `get_edition` and send back every story. Rules the server enforces:
- A story is identified by its `id`. Send the existing `id` to keep a story and its consent record. A story sent **without** an id is a brand-new story with consent `none`; a story left out of the list is deleted.
- Leaving `consent` out for an existing id keeps its current consent. Setting `consent: "confirmed"` needs `consentVia` (how it was given). `consent: "none"` clears it. You may add a `company` and a `consentNote` (for example what exactly was agreed).
- **If the topic or the founder of an existing story changes, its consent resets to "none"**, because consent covers one specific story. The result tells you (`consentReset`). Ask the editor whether the founder agreed to the new story before confirming again. The only exception is if the editor says the earlier agreement still covers it; then send `consent: "confirmed"` and `consentVia` explicitly.
- Record a follow-up result on a story by sending its `outcome` (with the whole list, ids intact).

## Writing the body

The newsletter's header and footer come from the template; you write only the **body** and pass it as `bodyHtml` to `save_edition`. For the brand style and the exact HTML blocks to build it from, see `brand-and-html.md` — read that file whenever you are writing or reviewing body HTML.

**Voice:** warm, plain and concrete, like a helpful neighbour who runs a startup hub. Short paragraphs. No hype words. Keep the whole newsletter short; the editor and leadership prefer brief. Content that helps people practise and adopt AI is especially valued. Name real people, places and dates.

**Typical order (adjust as asked):** a one or two sentence intro, the founder spotlight (if any), a call to apply to the AI Residency, then upcoming events, then anything else. Omit sections that have nothing in them rather than filling space.

**Also write:** a subject line (short, specific, no clickbait, under about 60 characters) and preview text (one sentence, up to 200 characters, that adds to the subject instead of repeating it).

**Events:** use each event's exact `title`, `startLocal` (already in Halifax time), `location` and `url` from `get_upcoming_events`. Add a "Sign Up" link only when the event has a `url`. Cancelled events are already left out. If an event has `nextOccurrence`, past events can link to the next one. Note that this only matches a later event with the same title (ignoring case and extra spaces), so titles that vary ("CEO Breakfast with X" vs "with Y") are not linked; use your own judgement about recurring series from the full list. Do not paste long descriptions; one line is enough.

## Previewing and testing

- **Preview:** call `render_edition` (no id = latest; pass the `editionId`). Show the returned `html` as an HTML artifact so the editor can see it, **copied exactly as returned**: do not rewrite, restyle, "improve" or re-theme it, and do not rebuild it from memory. The page is intentionally dark, and the artifact must keep its own dark background. If you cannot reproduce it exactly, say so instead of showing a different design. Do not use the artifact **Share** button: shared links are public and this is unpublished. Tell them the artifact can differ slightly from real email clients.
- **Test email:** offer `send_test` with the editor's Volta address (ask which; 1 to 5). Only addresses at exactly the allowed Volta domain (`@voltaeffect.com`; subdomains and other domains are not accepted) are allowed; a request containing any other address is refused entirely and nothing is sent. The edition needs a body. It works even before founder consent is confirmed, and it never reaches the subscriber list or touches the real draft.

## Creating the Mailchimp draft

1. Check the edition has a subject, preview text and body, and every featured story shows consent confirmed.
2. Tell the editor what you are about to do (subject, preview text, which founders and their consent) and ask for a go-ahead.
3. Call `create_draft` with the `editionId`. It refuses if consent is missing; explain why and what would fix it, do not retry with altered consent. It also refuses if this edition's campaign was already sent or scheduled (start a new edition for the next send).
4. Give the editor the link, and pass on any `checklistProblems` Mailchimp reports (they may block sending). Remind them: **they** review and send it from Mailchimp, and in Mailchimp they can edit the text in the body section.
5. **Pushing again replaces the draft.** If the edition already has a draft, `create_draft` is refused unless you pass `overwrite: true`, because re-pushing overwrites the draft with the saved edition and **discards any edits the editor made directly in Mailchimp**. Ask first: "This will replace what's in Mailchimp with the saved version, losing any changes you made there. OK?" Only then use `overwrite: true`. If the editor deleted the draft in Mailchimp, a new one is created automatically (no overwrite needed).
6. If consent is withdrawn after a draft exists, `save_edition` warns about it (`mailchimpDraftWarnings`). Offer `delete_draft` with the `editionId` (confirm first). It only deletes unsent drafts and keeps the edition's content.

## Changing the template (the header, footer and look)

Only when asked. Steps: `get_template`, make the smallest change that does what was asked, show a preview (put a sample body inside the `mc:edit="body"` region), get a yes, then `update_template` with the full HTML and a short note. Keep exactly one `mc:edit="body"` region and, in the footer, the `*|UNSUB|*` unsubscribe link and `*|LIST:ADDRESSLINE|*` address; on Mailchimp's free plan also `*|REWARDS|*` (only a warning if missing). The server refuses templates with scripts, `javascript:` links or `onclick`-style attributes. Restoring a version overwrites the live template, so confirm first as well. Undo with `restore_template` (`"previous"` for the last change) or pick from `list_template_versions` (newest 10 kept). Mailchimp cannot offer drag-and-drop editing for templates made this way; layout changes are done by you rewriting the HTML on request.

## The Monday review (when a schedule invokes you, not the editor)

Some editors set up a recurring Claude task (Claude's own scheduling, set up on their own account) that runs this automatically, for example every Monday morning. When you are invoked this way, instead of by a live chat message, nobody is there to answer questions, so follow this sequence and then stop:

1. Call `list_editions`. If the most recent edition is still `in_progress` (no Mailchimp draft yet), continue it. If it is already `drafted` (it has a live Mailchimp draft) or none exists, **start a new edition instead** — never touch an edition that already has a draft in Mailchimp; re-pushing it would need `overwrite` and could discard the editor's edits, and nobody is here to approve that.
2. Call `get_upcoming_events` for the weeks since the last edition's window (default to the next 30 days if unsure), and `backlog_list` (default `idea` status, plus `dueBy` today) for founders due a look.
3. **Search for news.** Volta's network startup list is a separate, external resource — **it is not the backlog**. The backlog is the editor's own scratchpad: people *he* has already decided are worth revisiting, with his own notes and dates. The network list is who Volta's community actually contains, kept and given to you by the editor or whoever maintains it; ask for it if you were not given one this run, and do not assume the backlog is a substitute. Search the web for recent news about a handful of startups from that list — funding, launches, awards, press coverage. Treat every result as a lead, not a fact, and note the source. Anything promising becomes a **new** entry in the backlog (`backlog_add`), or a note on an existing one (`backlog_update` with `appendNote`) — that is the one-way handoff: something interesting on the external list becomes one of the editor's own notes to follow up on. Never write a web result straight into the newsletter body. Pick a small, different handful each run rather than the whole list every week; `backlog_list` shows you who has already been noted recently, so you do not repeat yourself.
4. **Check for job postings.** For the same handful, check their own website's careers or jobs page — a startup hiring is often worth a mention on its own. (Other job boards are not yet cleared for this; stick to each startup's own site until told otherwise.) Note anything found the same way as news: a new or updated backlog entry, never something written straight into the body.
5. Build the full body, the same as any other draft (see "Featuring a founder" and "Writing the body"): the events section always; a real founder spotlight, written out, for the most promising backlog entry or entries, with **consent left as `none`**. Never mark consent confirmed on a scheduled run — you cannot ask anyone.
6. Save with `save_edition`. **Never call `create_draft` on a scheduled run**: nothing needing consent can be confirmed unattended, so there is nothing ready to push to Mailchimp yet.
7. For each story with unconfirmed consent, prepare the consent-request materials described in "Asking a founder for consent" — the one-story preview artifact and the draft message — **but do not publish the artifact yet**; leave that for the editor to say go-ahead on, same as any other publish. Have the drafts ready for them to review Monday morning.
8. Call `render_edition` for the full preview, and `compare_campaigns` plus `get_audience_stats` for a short analytics summary of the last sent issue.
9. Finish with the preview (as an artifact, same rule as always: shown exactly as returned, never the Share button) and a short summary: which stories still need a decision (and that their consent-request drafts are ready), any new leads you added to the backlog in steps 3 and 4, and the analytics summary. Ask what to keep, cut or change — this is what the editor opens when the task finishes, and it is meant to be reacted to, not just read.

This never replaces the editor starting a chat normally; it only leaves them a starting point instead of a blank one.
