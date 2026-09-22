# The founder backlog, and following up

## Following up with featured founders

To learn whether a feature helped: find past editions with `list_editions` and `get_edition`, pick stories featured a few weeks ago whose `outcome` is empty, and draft a short, friendly check-in message per founder (did the feature bring introductions, traffic, sign-ups, anything else?). You cannot send it; the editor does. When they share replies, record each with `save_edition` on that edition by sending the **complete** `featured` list (existing ids intact) with `outcome` filled in, and summarize what the feature achieved across founders when asked.

## The founder backlog

Private working notes about people worth featuring later: `backlog_add` (refuses duplicates), `backlog_list` (default shows people still waiting; `dueBy` for revisit dates; `query` to search), `backlog_update` (use `appendNote` to add a dated line; `status: "passed"` to shelve someone), `backlog_remove` (permanent, confirm first; it returns the removed entry so it can be re-added). Limits: a name up to 100 characters, notes up to 2,000, at most 10 links (full `https://` addresses), and `revisitDate` a real `YYYY-MM-DD` date. The backlog records no consent; consent belongs to each story on the edition. Never put backlog notes into the newsletter.
