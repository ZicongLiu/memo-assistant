import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  etaStatus, etaBadge,
  nextDueDate, spawnRecurring,
  isOffHours, hoursSince, shouldRunDigest,
  buildProjectTree, isProjectDescendant,
  buildTaskTree, getTaskDepth, isTaskDescendant,
  generateProjectMarkdown,
  today,
} from "../lib/utils";
import type { Project, Task } from "../lib/utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Use local-timezone date string to match etaStatus LOCAL parsing
const mkDate = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── etaStatus ────────────────────────────────────────────────────────────────
describe("etaStatus", () => {
  it("returns null for missing eta", () => expect(etaStatus(null)).toBeNull());
  it("returns null for undefined eta", () => expect(etaStatus(undefined)).toBeNull());
  it("returns null for invalid date string", () => expect(etaStatus("not-a-date")).toBeNull());
  it("returns 'overdue' for past date", () => expect(etaStatus(mkDate(-3))).toBe("overdue"));
  it("returns 'today' for today's date", () => expect(etaStatus(mkDate(0))).toBe("today"));
  it("returns 'soon' for 1 day away", () => expect(etaStatus(mkDate(1))).toBe("soon"));
  it("returns 'soon' for 2 days away", () => expect(etaStatus(mkDate(2))).toBe("soon"));
  it("returns 'ok' for 5 days away", () => expect(etaStatus(mkDate(5))).toBe("ok"));
});

// ─── etaBadge ────────────────────────────────────────────────────────────────
describe("etaBadge", () => {
  it("returns null for null eta", () => expect(etaBadge(null)).toBeNull());
  it("returns null for 'ok' eta", () => expect(etaBadge(mkDate(5))).toBeNull());
  it("returns red badge for overdue", () => {
    const badge = etaBadge(mkDate(-1));
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Overdue");
    expect(badge!.color).toBe("#dc2626");
  });
  it("returns yellow badge for today", () => {
    const badge = etaBadge(mkDate(0));
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Due today");
  });
  it("returns orange badge for soon", () => {
    const badge = etaBadge(mkDate(1));
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("Due soon");
  });
});

// ─── nextDueDate ─────────────────────────────────────────────────────────────
describe("nextDueDate", () => {
  const base = "2026-01-01";

  it("daily adds 1 day", () => expect(nextDueDate(base, "daily")).toBe("2026-01-02"));
  it("weekly adds 7 days", () => expect(nextDueDate(base, "weekly")).toBe("2026-01-08"));
  it("biweekly adds 14 days", () => expect(nextDueDate(base, "biweekly")).toBe("2026-01-15"));
  it("monthly advances 1 month", () => expect(nextDueDate(base, "monthly")).toBe("2026-02-01"));
  it("custom adds specified days", () => expect(nextDueDate(base, "custom", "3")).toBe("2026-01-04"));
  it("custom defaults to 1 day for invalid value", () => expect(nextDueDate(base, "custom", "abc")).toBe("2026-01-02"));
  it("returns empty string for invalid base date", () => expect(nextDueDate("bad-date", "daily")).toBe(""));
  it("none does not change the date", () => expect(nextDueDate(base, "none")).toBe(base));
});

// ─── spawnRecurring ───────────────────────────────────────────────────────────
describe("spawnRecurring", () => {
  const baseTask: Task = {
    id: "t1", title: "Weekly review", done: true, priority: "Medium",
    projectId: "p1", createdAt: "2026-01-01", eta: "2026-01-01",
    recur: "weekly", subtasks: [{ id: "s1", title: "Check notes", done: true }],
  };

  it("assigns a new unique id", () => {
    const spawned = spawnRecurring(baseTask);
    expect(spawned.id).not.toBe("t1");
    expect(typeof spawned.id).toBe("string");
  });
  it("resets done to false", () => expect(spawnRecurring(baseTask).done).toBe(false));
  it("sets createdAt to today", () => expect(spawnRecurring(baseTask).createdAt).toBe(today()));
  it("advances eta by recurrence interval", () =>
    expect(spawnRecurring(baseTask).eta).toBe("2026-01-08"));
  it("resets all subtasks to not done", () => {
    const spawned = spawnRecurring(baseTask);
    expect((spawned.subtasks as Array<{ done: boolean }>).every(s => !s.done)).toBe(true);
  });
  it("clears completedAt", () => expect(spawnRecurring({ ...baseTask, completedAt: "2026-01-01" }).completedAt).toBeUndefined());
});

// ─── isOffHours ───────────────────────────────────────────────────────────────
describe("isOffHours", () => {
  const settings = { workStart: "09:00", workEnd: "18:00" };

  it("returns true before work start", () => {
    vi.setSystemTime(new Date("2026-03-17T07:30:00"));
    expect(isOffHours(settings)).toBe(true);
  });
  it("returns false during work hours", () => {
    vi.setSystemTime(new Date("2026-03-17T13:00:00"));
    expect(isOffHours(settings)).toBe(false);
  });
  it("returns true after work end", () => {
    vi.setSystemTime(new Date("2026-03-17T19:00:00"));
    expect(isOffHours(settings)).toBe(true);
  });
  it("returns true exactly at work end time", () => {
    vi.setSystemTime(new Date("2026-03-17T18:00:00"));
    expect(isOffHours(settings)).toBe(true);
  });

  afterEach(() => vi.useRealTimers());
  beforeEach(() => vi.useFakeTimers());
});

// ─── hoursSince ───────────────────────────────────────────────────────────────
describe("hoursSince", () => {
  it("returns Infinity for null", () => expect(hoursSince(null)).toBe(Infinity));
  it("returns Infinity for undefined", () => expect(hoursSince(undefined)).toBe(Infinity));
  it("returns ~0 for just now", () => {
    expect(hoursSince(new Date().toISOString())).toBeLessThan(0.01);
  });
  it("returns ~24 for 24 hours ago", () => {
    const ts = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    expect(hoursSince(ts)).toBeCloseTo(24, 0);
  });
});

// ─── shouldRunDigest ─────────────────────────────────────────────────────────
describe("shouldRunDigest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns false if already ran today", () => {
    vi.setSystemTime(new Date("2026-03-17T11:00:00")); // Tuesday
    expect(shouldRunDigest("2026-03-17", "10:00")).toBe(false);
  });
  it("returns false before the scheduled time", () => {
    vi.setSystemTime(new Date("2026-03-17T09:00:00")); // Tuesday 9am
    expect(shouldRunDigest(null, "10:00")).toBe(false);
  });
  it("returns true after the scheduled time on a workday", () => {
    vi.setSystemTime(new Date("2026-03-17T10:01:00")); // Tuesday 10:01
    expect(shouldRunDigest(null, "10:00")).toBe(true);
  });
  it("returns false on weekends", () => {
    vi.setSystemTime(new Date("2026-03-15T11:00:00")); // Sunday
    expect(shouldRunDigest(null, "10:00")).toBe(false);
  });
  it("returns true exactly at scheduled minute", () => {
    vi.setSystemTime(new Date("2026-03-17T10:00:00")); // Tuesday exact time
    expect(shouldRunDigest("2026-03-16", "10:00")).toBe(true);
  });
});

// ─── buildProjectTree ─────────────────────────────────────────────────────────
describe("buildProjectTree", () => {
  const projects: Project[] = [
    { id: "a", name: "A", color: "#fff", createdAt: "2026-01-01" },
    { id: "b", name: "B", color: "#fff", createdAt: "2026-01-01", parentId: "a" },
    { id: "c", name: "C", color: "#fff", createdAt: "2026-01-01", parentId: "b" },
    { id: "d", name: "D", color: "#fff", createdAt: "2026-01-01" },
  ];

  it("returns only root projects at top level", () => {
    const tree = buildProjectTree(projects);
    expect(tree.map(p => p.id)).toEqual(["a", "d"]);
  });
  it("nests children correctly", () => {
    const tree = buildProjectTree(projects);
    expect(tree[0].children.map(p => p.id)).toEqual(["b"]);
  });
  it("supports deep nesting (grandchild)", () => {
    const tree = buildProjectTree(projects);
    expect(tree[0].children[0].children.map(p => p.id)).toEqual(["c"]);
  });
  it("leaf node has empty children array", () => {
    const tree = buildProjectTree(projects);
    expect(tree[0].children[0].children[0].children).toEqual([]);
  });
});

// ─── isProjectDescendant ──────────────────────────────────────────────────────
describe("isProjectDescendant", () => {
  const projects: Project[] = [
    { id: "root", name: "Root", color: "#fff", createdAt: "2026-01-01" },
    { id: "child", name: "Child", color: "#fff", createdAt: "2026-01-01", parentId: "root" },
    { id: "grand", name: "Grand", color: "#fff", createdAt: "2026-01-01", parentId: "child" },
    { id: "other", name: "Other", color: "#fff", createdAt: "2026-01-01" },
  ];

  it("detects direct child", () => expect(isProjectDescendant("child", "root", projects)).toBe(true));
  it("detects grandchild", () => expect(isProjectDescendant("grand", "root", projects)).toBe(true));
  it("returns false for non-descendant", () => expect(isProjectDescendant("other", "root", projects)).toBe(false));
  it("returns false for ancestor check", () => expect(isProjectDescendant("root", "child", projects)).toBe(false));
  it("prevents self-check", () => expect(isProjectDescendant("root", "root", projects)).toBe(false));
});

// ─── buildTaskTree ────────────────────────────────────────────────────────────
describe("buildTaskTree", () => {
  const tasks: Task[] = [
    { id: "t1", title: "Parent", done: false, priority: "High", projectId: "p1", createdAt: "2026-01-01" },
    { id: "t2", title: "Child", done: false, priority: "Medium", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t1" },
    { id: "t3", title: "Grandchild", done: false, priority: "Low", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t2" },
    { id: "t4", title: "Orphan", done: false, priority: "Low", projectId: "p1", createdAt: "2026-01-01" },
  ];

  it("returns only root tasks at top level", () => {
    const tree = buildTaskTree(tasks);
    expect(tree.map(t => t.id)).toEqual(["t1", "t4"]);
  });
  it("nests child tasks correctly", () => {
    const tree = buildTaskTree(tasks);
    expect(tree[0].children.map(t => t.id)).toEqual(["t2"]);
  });
  it("supports infinite depth (grandchild)", () => {
    const tree = buildTaskTree(tasks);
    expect(tree[0].children[0].children.map(t => t.id)).toEqual(["t3"]);
  });
});

// ─── getTaskDepth ────────────────────────────────────────────────────────────
describe("getTaskDepth", () => {
  const tasks: Task[] = [
    { id: "t1", title: "Root", done: false, priority: "High", projectId: "p1", createdAt: "2026-01-01" },
    { id: "t2", title: "Child", done: false, priority: "Medium", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t1" },
    { id: "t3", title: "Grandchild", done: false, priority: "Low", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t2" },
  ];

  it("root task has depth 0", () => expect(getTaskDepth("t1", tasks)).toBe(0));
  it("child task has depth 1", () => expect(getTaskDepth("t2", tasks)).toBe(1));
  it("grandchild task has depth 2", () => expect(getTaskDepth("t3", tasks)).toBe(2));
});

// ─── isTaskDescendant ────────────────────────────────────────────────────────
describe("isTaskDescendant", () => {
  const tasks: Task[] = [
    { id: "t1", title: "Root", done: false, priority: "High", projectId: "p1", createdAt: "2026-01-01" },
    { id: "t2", title: "Child", done: false, priority: "Medium", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t1" },
    { id: "t3", title: "Grandchild", done: false, priority: "Low", projectId: "p1", createdAt: "2026-01-01", parentTaskId: "t2" },
  ];

  it("detects direct child", () => expect(isTaskDescendant("t2", "t1", tasks)).toBe(true));
  it("detects grandchild", () => expect(isTaskDescendant("t3", "t1", tasks)).toBe(true));
  it("returns false for ancestor", () => expect(isTaskDescendant("t1", "t2", tasks)).toBe(false));
});

// ─── generateProjectMarkdown ─────────────────────────────────────────────────
describe("generateProjectMarkdown", () => {
  const project: Project = { id: "p1", name: "Dev", color: "#6366f1", notes: "Dev work", createdAt: "2026-01-01" };
  const tasks: Task[] = [
    { id: "t1", title: "Fix bug", done: false, priority: "High", projectId: "p1", category: "Work", eta: "2026-03-20", createdAt: "2026-01-01", notes: "Urgent fix", subtasks: [{ id: "s1", title: "Check logs", done: false }] },
    { id: "t2", title: "Write docs", done: false, priority: "Low", projectId: "p1", category: "Work", createdAt: "2026-01-01" },
    { id: "t3", title: "Deploy v1", done: true, projectId: "p1", priority: "High", createdAt: "2026-01-01", completedAt: "2026-03-10", subtasks: [{ id: "s2", title: "Run tests", done: true }] },
    { id: "t4", title: "Other project task", done: false, priority: "Medium", projectId: "p2", createdAt: "2026-01-01" },
  ];

  let md: string;
  beforeEach(() => { md = generateProjectMarkdown(project, tasks); });

  it("includes project name as H1", () => expect(md).toContain("# Dev"));
  it("includes project notes as blockquote", () => expect(md).toContain("> Dev work"));
  it("includes active tasks section with correct count", () => expect(md).toContain("## Active Tasks (2)"));
  it("groups active tasks by priority", () => expect(md).toContain("### High Priority"));
  it("formats active task as unchecked checkbox", () => expect(md).toContain("- [ ] **Fix bug**"));
  it("includes ETA in active task line", () => expect(md).toContain("📅 2026-03-20"));
  it("includes category in active task line", () => expect(md).toContain("🏷 Work"));
  it("includes task notes as blockquote", () => expect(md).toContain("  > Urgent fix"));
  it("includes subtask with unchecked state", () => expect(md).toContain("  - [ ] Check logs"));
  it("includes completed tasks section", () => expect(md).toContain("## Completed Tasks (1)"));
  it("formats completed task as checked strikethrough", () => expect(md).toContain("- [x] ~~Deploy v1~~"));
  it("includes completion date on done task", () => expect(md).toContain("✅ 2026-03-10"));
  it("includes done subtask under completed task", () => expect(md).toContain("  - [x] Run tests"));
  it("excludes tasks from other projects", () => expect(md).not.toContain("Other project task"));
  it("includes tag-project tasks", () => {
    const tagTask: Task = { id: "t5", title: "Tagged task", done: false, priority: "Medium", projectId: "p9", tagProjectIds: ["p1"], createdAt: "2026-01-01" };
    const result = generateProjectMarkdown(project, [...tasks, tagTask]);
    expect(result).toContain("Tagged task");
  });
});
