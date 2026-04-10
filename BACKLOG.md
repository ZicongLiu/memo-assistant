# FlowDesk — Development Backlog

This file mirrors open GitHub Issues. Each backlog item links to its Issue.
- New items: add here + `gh issue create` to open a GH Issue
- When resolved: close the GH Issue + move to Completed below

---

## Backlog

### [ BACKLOG ] Project-wise boards — [Issue #1](https://github.com/ZicongLiu/memo-assistant/issues/1)
**Requested:** 2026-04-10
**Description:**
- Each project can have multiple named boards (not tied to a calendar date)
- User can create, rename, switch between, and close/archive boards per project
- Boards live under a dedicated "Boards" tab
- **Note:** Data model, state, and handlers already exist in `page.tsx`. Missing: JSX render block for `tab === "boards"`.

### [ BACKLOG ] Update Dev Roadmap checklist in Settings — [Issue #2](https://github.com/ZicongLiu/memo-assistant/issues/2)
**Requested:** 2026-04-10
**Description:**
- Mark completed items in the hardcoded roadmap checklist: Mobile layout, subtask board UX, board history detail view

---

## Completed Items

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
