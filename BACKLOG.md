# FlowDesk — Development Backlog

This file tracks pending and resolved development items.
- Add new items with `[ BACKLOG ]` status.
- When picked up for implementation, change to `[ IN PROGRESS ]`.
- When done, change to `[ DONE ]` and add a resolution note.

---

## Backlog

### [ BACKLOG ] Project-wise boards (non-daily, multi-board per project)
**Requested:** 2026-04-10
**Description:**
- Each project can have multiple named boards (not tied to a calendar date)
- User can create, rename, switch between, and close/archive boards per project
- Boards live under a dedicated "Boards" tab
- **Note:** The data model (`ProjectBoard` interface), state variables, and most handler functions are already implemented in `page.tsx`. What's missing is the JSX render block for `tab === "boards"` — the UI to list boards, open a board detail view, and the wrap-up panel for project boards.

### [ BACKLOG ] GitHub Issues integration for backlog management
**Requested:** 2026-04-10
**Description:**
- Install `gh` CLI (`brew install gh && gh auth login`) to manage backlog items as GitHub Issues
- When a backlog item is added, create a corresponding GitHub Issue with a label (e.g. `backlog`)
- When resolved, close the Issue and add a resolution comment
- Blocked on: `gh` CLI not yet installed on this machine

### [ BACKLOG ] Dev Roadmap checklist in Settings — mark completed items
**Requested:** (implicit — existing checklist has "Mobile-friendly layout" still marked undone even though it's done)
**Description:**
- Update the Development Roadmap checklist in the Settings tab to reflect completed features
- Items to mark done: Mobile-friendly layout, subtask UX on board, board history detail view

---

## Completed Items

### [ DONE ] Task archive / soft delete
**Resolved:** 2026-04-10
**Resolution:** Deleting from Tasks tab archives the task (hidden from all views). Archived toggle in filter bar shows archived tasks with Restore and permanent Delete buttons. Deleting from the daily board only removes it from the board, task is preserved.

---

## Worklog

| Date       | Item                                      | Notes                                      |
|------------|-------------------------------------------|--------------------------------------------|
| 2026-04-10 | Task archive / soft delete                | Archive on delete, restore, permanent delete |
| 2026-04-10 | Save race condition fix                   | Drain-queue persist pattern with refs      |
| 2026-04-10 | One-board-per-day daily board simplification | Wrap-up no longer creates duplicate board |
| 2026-04-10 | Notes field on task creation              | Both Tasks tab and daily board setup form  |
| 2026-04-10 | Password-protected projects               | PBKDF2 hash, session TTL, email OTP reset  |
| 2026-04-10 | Backup / restore                          | JSON export + import with confirmation     |
| 2026-04-10 | Mobile / web layout toggle                | JS-based isMobile with manual override     |
