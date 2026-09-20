# Known issues and things to investigate

Smaller items to fix or look into later. Add to this as we go; move to HANDOFF.md if it affects Volta's production setup.

## Email rendering
- [ ] **Gradient renders as a solid purple bar.** In the direct Mailchimp test send, the top bar showed solid #6101FF in Outlook (expected: Outlook ignores CSS gradients). A Gmail test was sent directly to the developer's Gmail; result still to be recorded. Goal: keep the gradient and add solid fallbacks (`bgcolor`) on the top bar, pill button and accent strips. Fallback plan: stepped-color cells. Snippets in `scripts/gradient-snippets.html` (untested in real clients).
- [ ] **Footer shows "N/A · 2630 Windsor St…".** The "N/A" comes from the Mailchimp audience's default company/sender name, not the template. Fix in Mailchimp audience settings.
- [ ] The earlier multi-region template (no longer in this repo): the pill button's outer cell has no fallback background color.

## Calendar / events
- [ ] **"Next occurrence" matches on exact title only.** Recurring events in the feed are separate events, and titles vary per occurrence ("CEO Breakfast with Jon McGinley" vs "with Bethany Deshpande", "DEFCON Halifax October Meet-Up"), so exact matching misses most recurring series. Options: match on a normalized prefix, on category, or on a series key; or let Claude decide from the returned list.
- [ ] Feed download time varies (7 s from the dev machine, under 1 s from Cloudflare). Cache mitigates it (1 hour fresh, 24 hours stale fallback).
- [ ] Parsed descriptions are trimmed to 600 characters; full text is not available through the tool.
- [ ] The parser assumes the feed keeps expanding recurring events and using UTC. If an RRULE appears, events are flagged `hasRecurrence` but not expanded.

## Template
- [ ] **No drag-and-drop editing.** Templates created through the API from HTML are Mailchimp "classic"/code-your-own templates. The API cannot create templates for the newer drag-and-drop builder, so Bader cannot rearrange blocks visually in Mailchimp. What he can do (to be confirmed by opening the comparison drafts from `scripts/make-compare-drafts.mjs`): edit the text inside the `mc:edit="body"` region in Mailchimp's classic campaign editor. Layout and section changes are made by asking Claude (which rewrites the body HTML). This applies to any automation, not just ours.
- [x] **Decided: route A (Mailchimp template + body region).** KV holds the master shell and pushes it one way to a Mailchimp template; drafts send only the body. Tested both routes with real drafts: route A (template + sections) opened normally in Mailchimp's classic editor, while route B (full raw HTML pushed as content, opening in the `html-paste` wizard) loaded forever in the editor. Cause of the route B hang not determined (could be our HTML or Mailchimp's editor); not pursued.
- [ ] **KV can drift from Mailchimp.** The shell HTML lives in KV (Mailchimp cannot return template HTML), so a template edited directly in the Mailchimp editor is invisible to the server and would be overwritten by the next `update_template`. Possible mitigation: compare the template's `date_edited` from Mailchimp with `updatedAt` in KV and warn.
- [ ] `restore_template "previous"` relies on a pointer key in KV; KV is eventually consistent across regions, so an immediate restore right after an update from a different location could in theory read a stale pointer. Restoring by explicit version id is exact.
- [ ] Template validation is a basic safety check (one `body` region, unsubscribe/address tags, no scripts or inline handlers); it does not fully sanitize HTML.

## Mailchimp behaviour worth remembering
- Mailchimp's `GET /reports/{id}` returns 200 with zeros for drafts **and for deleted campaigns**, so it says nothing about whether a campaign exists or was sent. Always check `GET /campaigns/{id}` status first (`get_report` now does).
- Drafts orphaned by deleting them directly in Mailchimp are handled: `create_draft` sees the 404 and makes a new one.
- `send_test` is all-or-nothing on recipients: if any address is outside the allowed domains, nothing is sent.
- A draft whose story later loses consent stays in Mailchimp until `delete_draft` is used; `save_edition` now warns about it.

## Storage (Cloudflare KV)
- **Never rely on KV `list` for correctness.** It is eventually consistent (a key written seconds ago can be missing from a listing, and so can its metadata). This caused a real bug: the backlog's duplicate check and `dueBy` filter used listings and missed just-added entries. Fixed by storing the backlog as one document, and keeping edition and template-version indexes as documents read by exact key. Regression tests use a KV whose `list` shows nothing. Any new feature must follow the same rule.
- Everything is still last-write-wins; two people editing the backlog or the same edition in the same instant could overwrite each other. Fine for one or two editors.
- Exact-key reads can still be stale across regions for a short time in theory; in practice Claude's calls come from one location.

## Platform / operations
- [ ] **CPU time observation.** Workers free plan documents a 10 ms CPU limit, but the tail log for real requests showed 4 to 41 ms with every request succeeding (even a plain `tools/list` took 17 to 19 ms). Unclear whether the limit is enforced differently now. Keep watching; if errors (1102) appear, move to the $5 plan or trim work.
- [ ] After every deploy that adds or changes tools, the Claude connector must be refreshed/reconnected to see them (Claude reads the tool list at connect time). Put in the handoff notes.
- [ ] The consent page appears at every new sign-in (no "remember this app" step).
- [ ] Google test-mode authorizations expire after 7 days until the project is moved to an Internal (Workspace) project.
- [ ] `EXTRA_ALLOWED_EMAILS` is a dev-only Worker secret; remove at handoff (in HANDOFF.md).
