# 🐂 rodeo

A local, single-page task wrangler. Everything lives on your machine in a SQLite file —
no accounts, no cloud, no npm dependencies. It pulls open work from Jira and Outlook
so the list you look at each morning is the whole list.

## Run it

```bash
npm start
```

Then open <http://127.0.0.1:4444>. The server binds to loopback only and refuses
non-local requests, so nothing on your network can reach it.

Requires Node 22.5+ (uses the built-in `node:sqlite`). There is nothing to install.

## The daily loop
**All open** is the working list, in the order you arranged it, with subtasks
nested under their parents so a task's context comes with it. **Closed** is the
same list in reverse, newest first. A task is `todo`, `blocked`, or `done` —
there is no in-between state to maintain.

Drag any row by its body to reorder it; drop it below the last row to send it to
the bottom. Click a title to rename it in place — `↵` or clicking away keeps the
edit, `Esc` throws it out. `✎` opens the full editor inline beneath the row.

Tick the box and the row's two sloped sides sweep in, wipe the task off the list,
meet as a check and drift away while the rest slides up. The task is saved the
moment you tick it, so the flourish never stands between you and the next one.

**What did I do today?** in the header lists everything you closed, every meeting
on your Outlook calendar, and every progress-log entry you wrote, for today or any
earlier day. Meetings are read live from the calendar each time you open it, so
they need Outlook connected; declined and cancelled ones are left out, and each
of the rest is marked accepted, tentative, no reply, or one you organized.

**Quick add** drops the new task at the top of the list; `⇧↵` sends it to the
bottom instead. It accepts inline shorthand:

```
Fix quote totals !high @2026-09-01 ~3h #QAD-1017
```

| token | meaning |
| --- | --- |
| `!low` `!normal` `!high` `!urgent` | priority |
| `@2026-09-01` `@today` `@tomorrow` `@fri` `@+3` | due date |
| `~3h` `~0.5h` | estimate in hours |
| `#QAD-1017` | marks the source as Jira with that issue key |
| `#ecrash` | a tag — any `#word` that isn't an issue key |

### Tags

A tag is any `#word` in a task title, so the title is the only place they live:
add one by typing it, drop one by deleting it. Tagged rows are washed in the
colour of their **first** tag, and the source colour moves to a stripe down the
left edge. Untagged rows look the same as always.

**Tags** in the header lists every tag in use with a colour picker and a task
count. New tags start on the next unused colour from a built-in palette. One
sharp edge: `#ecrash-2` reads as a Jira issue key, not a tag, because issue keys
are `#LETTERS-NUMBER`.

**Keyboard:** `n` focus quick add · `/` focus search · `s` sync · `Esc` close editors and dialogs.
In the progress log, `⌘↵` saves an entry.

Every task gets a permanent id shown as `R-4`. Use those ids when you tell Claude
about your work — "R-4 is done", "what's blocking R-12".

### Nesting and dependencies

Two different relationships, deliberately kept apart:

- **Nesting** (parent → child) is decomposition. Set a *Parent task* in the row
  editor, or hit `↳` on a row to add a subtask. A parent shows a rollup of its open
  children's hours. Deleting a parent deletes its subtasks.
- **Dependencies** (`blocked by`) are sequencing, and they work across the tree.
  A task with an unfinished dependency renders hatched with a `⛔ needs R-2` chip
  and counts toward *blocked* in the stats bar. Circular dependencies are rejected,
  including indirect ones.

### Notes

Each task has two note surfaces. The **scratchpad** is a free-form field you
overwrite as you go. The **progress log** is append-only and timestamped — use it
to record what you tried, who you talked to, what you're waiting on.

## Integrations

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

`config.json` is gitignored — it holds your tokens. Restart the server after editing.
Then hit **⟳ Sync** (or `s`).

### Jira

**Jira Cloud** — create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>:

```json
{
  "jira": {
    "enabled": true,
    "flavor": "cloud",
    "baseUrl": "https://your-team.atlassian.net",
    "email": "you@company.com",
    "apiToken": "paste-token-here",
    "jql": "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC"
  }
}
```

**Jira Server / Data Center** — use a Personal Access Token from your profile menu,
leave `email` blank, and set `"flavor": "server"`.

The `jql` field is the whole selection rule; anything you can write in Jira's
search box works here, so narrow it to whatever you actually want to track.

### Outlook

Outlook uses Microsoft Graph, which needs an app registration in your tenant.
In the [Azure portal](https://portal.azure.com) → *Microsoft Entra ID* → *App registrations* → *New registration*:

1. Name it anything (`rodeo`). Accounts: *this organizational directory only* is fine.
2. No redirect URI needed.
3. Open *Authentication* → *Advanced settings* → set **Allow public client flows** to **Yes**.
4. Open *API permissions* → add **Mail.Read**, **Tasks.Read**, **User.Read**,
   **Calendars.Read** (delegated). If your tenant requires admin consent, ask your
   admin to grant it. Adding a permission later doesn't extend a sign-in you
   already made — click **Connect** again to consent to it.
5. Copy the *Application (client) ID* and *Directory (tenant) ID* into `config.json`:

```json
{
  "outlook": {
    "enabled": true,
    "clientId": "00000000-0000-0000-0000-000000000000",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "flaggedMail": true,
    "todo": false
  }
}
```

Restart, click **⚙ → Connect**, and sign in with the device code it shows you.
Tokens are cached in `data/outlook-token.json` (mode 600) and refreshed automatically.

Flagged mail becomes a task with a link straight back to the message. Turn on
`"todo": true` to also pull Microsoft To Do items.

### What sync will and won't touch

Sync is deliberately timid about your edits.

| rodeo owns | the provider owns |
| --- | --- |
| status, notes, progress log, parent, dependencies, priority | title, description, link, remote status |

A due date or estimate from the provider is only used to *fill a blank* — once you
set one locally it's yours. Issues that are already closed are never imported. When
a tracked issue closes upstream, its rodeo task is marked done (turn that off with
`"mirrorClosed": false`).

## Where the data lives

`data/rodeo.db` — a plain SQLite file, gitignored. Back it up by copying it, or:

```bash
curl -s localhost:4444/api/export > ~/Desktop/rodeo-backup.json
```

Inspect it directly any time with `sqlite3 data/rodeo.db`.

## HTTP API

Useful if you want Claude (or anything else) to read and update your list.

| method | path | notes |
| --- | --- | --- |
| `GET` | `/api/state` | everything the UI renders: tasks, deps, notes, integration status |
| `GET` | `/api/recap/meetings?day=YYYY-MM-DD` | that day's Outlook meetings; `available: false` with a reason when it can't ask |
| `POST` | `/api/tasks` | `{title, due_date, estimate_hours, priority, source_type, parent_id, blocked_by}` |
| `PATCH` | `/api/tasks/:id` | partial update of any field |
| `DELETE` | `/api/tasks/:id` | cascades to subtasks |
| `POST` | `/api/tasks/:id/move` | `{parent_id, after_id}` |
| `POST` | `/api/tasks/:id/notes` | `{body}` — appends a timestamped log entry |
| `POST` | `/api/tasks/:id/deps` | `{depends_on_id}` |
| `DELETE` | `/api/tasks/:id/deps/:depId` | |
| `POST` | `/api/sync` | `{only: "jira"}` to sync one provider |
| `GET` | `/api/export` | full JSON dump |

```bash
curl -s localhost:4444/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Ship the trim kit change","due_date":"2026-09-01","estimate_hours":3}'
```

## Keep it running

To have rodeo start at login, save this as
`~/Library/LaunchAgents/com.local.rodeo.plist` and run
`launchctl load ~/Library/LaunchAgents/com.local.rodeo.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.rodeo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>REPLACE_WITH_PATH/rodeo/server/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Point `ProgramArguments` at your actual node binary (`which node`) and rodeo path.
