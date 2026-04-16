# FlowDesk — Development Backlog

This file mirrors open GitHub Issues. Each backlog item links to its Issue.
- New items: add here + `gh issue create` to open a GH Issue
- When resolved: close the GH Issue + move to Completed below

---

## Backlog

### [ BACKLOG ] Deploy FlowDesk to Fly.io — [Issue #5](https://github.com/ZicongLiu/memo-assistant/issues/5)
**Requested:** 2026-04-14
**Description:**
- All infrastructure is ready (Dockerfile, fly.toml, middleware, login page). Pending: run the actual deployment steps from `DEPLOY.md`.
- Key commands: `fly launch`, `fly volumes create flowdesk_data`, `fly secrets set APP_PASSPHRASE=...`, `fly deploy`
- Optional follow-up: custom domain, SMTP secrets for OTP email, always-on setting

### [ BACKLOG ] Encrypt notes at rest for locked projects — [Issue #4](https://github.com/ZicongLiu/memo-assistant/issues/4)
**Requested:** 2026-04-13
**Description:**
- Notes for locked projects are currently stored as plain text in `hub.db` and `backup.json`
- Encrypt notes client-side using **AES-256-GCM** with a key derived from the project password via PBKDF2 (same salt already stored per project)
- Store as `enc:v1:<base64-iv>:<base64-ciphertext>` so encrypted blobs are detectable
- On setting a password: encrypt all existing task + subtask notes for that project
- On unlock: decrypt in the browser — server never sees plain text
- On password change: re-encrypt all notes with the new key
- On removing a password: decrypt all notes back to plain text before clearing the hash
- Graceful error if decryption fails (wrong key, corrupted data)

### [ BACKLOG ] Mobile-friendly responsive layout — [Issue #6](https://github.com/ZicongLiu/memo-assistant/issues/6)
**Requested:** 2026-04-14
**Description:**
- True responsive layout that adapts automatically (no manual toggle needed)
- Sidebar collapses to hamburger/drawer on mobile; bottom nav already partially in place
- Task cards, filter pills, board views adapt to narrow screens
- Remove the manual 📱/🖥 toggle once proper responsiveness is in place

### [ BACKLOG ] Daily board — summary stats (streak, completion rate) — [Issue #7](https://github.com/ZicongLiu/memo-assistant/issues/7)
**Requested:** 2026-04-14
**Description:**
- Streak: consecutive days with at least one task completed
- Completion rate over 7/30 days; weekly summary vs prior week
- Small stats bar above/below the board or collapsible section

### [ BACKLOG ] Retro mode — review past boards, celebrate wins, identify blockers — [Issue #8](https://github.com/ZicongLiu/memo-assistant/issues/8)
**Requested:** 2026-04-14
**Description:**
- Browse wrapped daily/project boards by date range
- Highlight chronic carry-over tasks (3+ days unresolved)
- Calendar/heatmap of completions; "wins" view for last 7/30 days

### [ BACKLOG ] Task dependencies — block/unblock flow — [Issue #9](https://github.com/ZicongLiu/memo-assistant/issues/9)
**Requested:** 2026-04-14
**Description:**
- "Blocked by" relationship between tasks; blocked tasks show 🚫 + blocker title
- Auto-unblock when blocker is marked done
- Exclude blocked tasks from daily board setup suggestions

### [ BACKLOG ] Recurring tasks — daily / weekly repeats — [Issue #10](https://github.com/ZicongLiu/memo-assistant/issues/10)
**Requested:** 2026-04-14
**Description:**
- Recurrence options: daily, weekdays, weekly, every N days
- On completion: reset or spawn new instance for next occurrence
- Show next-due date on task card; suggest on daily board setup when due

### [ BACKLOG ] Export tasks as CSV or Markdown — [Issue #11](https://github.com/ZicongLiu/memo-assistant/issues/11)
**Requested:** 2026-04-14
**Description:**
- CSV: title, priority, project, status, dates, notes (if unlocked)
- Markdown: checklist format, grouped by project or priority
- Filter before export: project, status, date range
- Export button in Tasks tab toolbar or Settings → Backup section

### [ BACKLOG ] Update Dev Roadmap checklist in Settings — [Issue #2](https://github.com/ZicongLiu/memo-assistant/issues/2)
**Requested:** 2026-04-10
**Description:**
- Mark completed items in the hardcoded roadmap checklist: Mobile layout, subtask board UX, board history detail view

---

## Completed Items

### [ DONE ] Host app on internet — [Issue #3](https://github.com/ZicongLiu/memo-assistant/issues/3)
**Resolved:** 2026-04-13
**Resolution:** Dockerfile (multi-stage, Alpine + better-sqlite3), fly.toml with 1 GB persistent volume, passphrase access gate (middleware + login page + `/api/auth-app`), session cookie auth. See `DEPLOY.md` for full instructions.

### [ DONE ] Project-wise boards — [Issue #1](https://github.com/ZicongLiu/memo-assistant/issues/1)
**Resolved:** 2026-04-13
**Resolution:** Boards tab fully implemented — list view (grouped by project, progress bars), setup flow (name + date + project + task picker), detail view (toggle done, remove tasks, rename, change date, delete), and wrap-up panel (resolve/carry-over).

### [ DONE ] Task archive / soft delete
**Resolved:** 2026-04-10
**Resolution:** Deleting from Tasks tab archives the task. Archived toggle in filter bar shows archived tasks with Restore and permanent Delete buttons.

### [ DONE ] GitHub Issues integration for backlog management
**Resolved:** 2026-04-10
**Resolution:** `gh` CLI installed and authenticated. Backlog items now tracked as GitHub Issues with labels. Workflow: `gh issue create` to add, `gh issue close` to resolve.

---

## Worklog

| Date       | Item                                      | Notes                                      |
|------------|-------------------------------------------|--------------------------------------------|
| 2026-04-10 | GitHub Issues backlog integration         | gh CLI authenticated, labels created, issues #1 #2 opened |
| 2026-04-10 | Task archive / soft delete                | Archive on delete, restore, permanent delete |
| 2026-04-10 | Save race condition fix                   | Drain-queue persist pattern with refs      |
| 2026-04-10 | One-board-per-day daily board simplification | Wrap-up no longer creates duplicate board |
| 2026-04-10 | Notes field on task creation              | Both Tasks tab and daily board setup form  |
| 2026-04-10 | Password-protected projects               | PBKDF2 hash, session TTL, email OTP reset  |
| 2026-04-10 | Backup / restore                          | JSON export + import with confirmation     |
| 2026-04-10 | Mobile / web layout toggle                | JS-based isMobile with manual override     |
| 2026-04-13 | Lock behavior redesign                    | Tasks visible in locked projects; notes masked per-task; per-project expiry config; unlock-all banner |
| 2026-04-13 | Hosting backlog item                      | Added to BACKLOG.md + GH Issue #3         |
| 2026-04-13 | Project boards tab                        | Full UI — list, setup, detail, wrap-up. GH Issue #1 closed |
| 2026-04-13 | Fly.io deployment                         | Dockerfile, fly.toml, passphrase gate, DEPLOY.md. GH Issue #3 closed |
| 2026-04-13 | Notes encryption backlog item             | AES-256-GCM client-side, PBKDF2 key derivation. GH Issue #4 opened  |
| 2026-04-14 | Today board auto-select fix               | Only carry-over tasks pre-selected; new tasks start unchecked        |
| 2026-04-14 | Backlog sync                              | Issues #5–#11 opened for all pending roadmap + session items         |
