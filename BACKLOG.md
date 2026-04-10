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

---

## Completed Items

*(None yet — items will be moved here when resolved)*

---

## Worklog

| Date       | Item                                      | Notes                                      |
|------------|-------------------------------------------|--------------------------------------------|
| 2026-04-10 | Save race condition fix                   | Drain-queue persist pattern with refs      |
| 2026-04-10 | One-board-per-day daily board simplification | Wrap-up no longer creates duplicate board |
| 2026-04-10 | Notes field on task creation              | Both Tasks tab and daily board setup form  |
| 2026-04-10 | Password-protected projects               | PBKDF2 hash, session TTL, email OTP reset  |
| 2026-04-10 | Backup / restore                          | JSON export + import with confirmation     |
| 2026-04-10 | Mobile / web layout toggle                | JS-based isMobile with manual override     |
