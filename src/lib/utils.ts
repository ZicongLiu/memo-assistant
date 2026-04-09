// ─── Pure utility functions (shared between app and tests) ───────────────────

export const uid = () => Math.random().toString(36).slice(2, 9);
/** Returns today's date in YYYY-MM-DD using LOCAL timezone (not UTC). */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const isWorkday = (d = new Date()) => d.getDay() > 0 && d.getDay() < 6;

export const PRIORITIES = ["Low", "Medium", "High"] as const;
export const RECUR_OPTIONS = ["none", "daily", "weekly", "biweekly", "monthly", "custom"] as const;

// ─── ETA helpers ─────────────────────────────────────────────────────────────

export function etaStatus(eta: string | null | undefined): "overdue" | "today" | "soon" | "ok" | null {
  if (!eta) return null;
  // Parse as LOCAL midnight to avoid UTC offset shifting "today" into "overdue"
  const parts = eta.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [year, month, day] = parts;
  const target = new Date(year, month - 1, day); // local midnight
  if (isNaN(target.getTime())) return null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0); // local midnight today
  const diff = Math.floor((target.getTime() - todayStart.getTime()) / 86400000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 2) return "soon";
  return "ok";
}

export function etaBadge(eta: string | null | undefined) {
  const st = etaStatus(eta);
  if (!st || st === "ok") return null;
  const map = {
    overdue: { bg: "#fee2e2", color: "#dc2626", label: "Overdue" },
    today:   { bg: "#fef3c7", color: "#d97706", label: "Due today" },
    soon:    { bg: "#fff7ed", color: "#ea580c", label: "Due soon" },
  };
  return map[st];
}

// ─── Recurrence helpers ───────────────────────────────────────────────────────

export function nextDueDate(eta: string, recur: string, customDays?: string | number): string {
  const base = eta ? new Date(eta) : new Date();
  if (isNaN(base.getTime())) return "";
  const d = new Date(base);
  if (recur === "daily")     d.setDate(d.getDate() + 1);
  else if (recur === "weekly")    d.setDate(d.getDate() + 7);
  else if (recur === "biweekly")  d.setDate(d.getDate() + 14);
  else if (recur === "monthly")   d.setMonth(d.getMonth() + 1);
  else if (recur === "custom")    d.setDate(d.getDate() + (parseInt(String(customDays ?? 1)) || 1));
  return d.toISOString().slice(0, 10);
}

export function spawnRecurring(task: Record<string, unknown>): Record<string, unknown> {
  return {
    ...task,
    id: uid(),
    done: false,
    createdAt: today(),
    completedAt: undefined,
    eta: nextDueDate(task.eta as string, task.recur as string, task.recurCustomDays as string),
    subtasks: ((task.subtasks ?? []) as Array<Record<string, unknown>>).map(s => ({ ...s, done: false })),
  };
}

// ─── Scheduling helpers ───────────────────────────────────────────────────────

export function isOffHours(settings: { workStart: string; workEnd: string }): boolean {
  const now = new Date();
  const [sh, sm] = settings.workStart.split(":").map(Number);
  const [eh, em] = settings.workEnd.split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins < sh * 60 + sm || mins >= eh * 60 + em;
}

export function hoursSince(iso: string | null | undefined): number {
  return iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity;
}

export function shouldRunDigest(last: string | null | undefined, time: string): boolean {
  if (!isWorkday()) return false;
  const now = new Date();
  const [h, m] = time.split(":").map(Number);
  const todayStr = now.toISOString().slice(0, 10);
  return last !== todayStr && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m));
}

// ─── Project tree helpers ─────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  color: string;
  notes?: string;
  parentId?: string | null;
  createdAt: string;
}

export interface ProjectNode extends Project {
  children: ProjectNode[];
}

export function buildProjectTree(projects: Project[], parentId: string | null = null): ProjectNode[] {
  return projects
    .filter(p => (p.parentId ?? null) === parentId)
    .map(p => ({ ...p, children: buildProjectTree(projects, p.id) }));
}

export function isProjectDescendant(projId: string, ancestorId: string, projects: Project[]): boolean {
  const p = projects.find(x => x.id === projId);
  if (!p || !p.parentId) return false;
  if (p.parentId === ancestorId) return true;
  return isProjectDescendant(p.parentId, ancestorId, projects);
}

// ─── Task tree helpers ────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  done: boolean;
  priority: string;
  projectId: string;
  parentTaskId?: string | null;
  tagProjectIds?: string[];
  subtasks?: Array<{ id: string; title: string; done: boolean; eta?: string }>;
  notes?: string;
  eta?: string;
  category?: string;
  completedAt?: string;
  deps?: string[];
  recur?: string;
  recurCustomDays?: string;
  createdAt: string;
}

export interface TaskNode extends Task {
  children: TaskNode[];
}

export function buildTaskTree(tasks: Task[], parentTaskId: string | null = null): TaskNode[] {
  return tasks
    .filter(t => (t.parentTaskId ?? null) === parentTaskId)
    .map(t => ({ ...t, children: buildTaskTree(tasks, t.id) }));
}

export function getTaskDepth(taskId: string, tasks: Task[]): number {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.parentTaskId) return 0;
  return 1 + getTaskDepth(task.parentTaskId, tasks);
}

export function isTaskDescendant(taskId: string, ancestorId: string, tasks: Task[]): boolean {
  const t = tasks.find(x => x.id === taskId);
  if (!t || !t.parentTaskId) return false;
  if (t.parentTaskId === ancestorId) return true;
  return isTaskDescendant(t.parentTaskId, ancestorId, tasks);
}

// ─── Markdown export ──────────────────────────────────────────────────────────

export function generateProjectMarkdown(project: Project, tasks: Task[]): string {
  const projTasks = tasks.filter(t => t.projectId === project.id || (t.tagProjectIds ?? []).includes(project.id));
  const active = projTasks.filter(t => !t.done);
  const done   = projTasks.filter(t => t.done);
  const priorityOrder = ["High", "Medium", "Low"];
  const lines: string[] = [];

  lines.push(`# ${project.name}`);
  if (project.notes) lines.push(`\n> ${project.notes}`);
  lines.push(`\n_Exported: ${new Date().toLocaleString()}_`);
  lines.push(`\n---\n`);
  lines.push(`## Active Tasks (${active.length})`);

  if (active.length === 0) {
    lines.push("_No active tasks._");
  } else {
    const grouped = priorityOrder
      .map(p => ({ p, items: active.filter(t => t.priority === p).sort((a, b) => (a.eta ?? "").localeCompare(b.eta ?? "")) }))
      .filter(g => g.items.length);
    grouped.forEach(({ p, items }) => {
      lines.push(`\n### ${p} Priority`);
      items.forEach(t => {
        const eta      = t.eta ? ` · 📅 ${t.eta}` : "";
        const cat      = t.category ? ` · 🏷 ${t.category}` : "";
        const blockers = (t.deps ?? []).length ? ` · 🔒 blocked` : "";
        lines.push(`- [ ] **${t.title}**${eta}${cat}${blockers}`);
        if (t.notes) lines.push(`  > ${t.notes}`);
        (t.subtasks ?? []).forEach(s => lines.push(`  - [${s.done ? "x" : " "}] ${s.title}`));
      });
    });
  }

  if (done.length) {
    lines.push(`\n---\n\n## Completed Tasks (${done.length})`);
    done.forEach(t => {
      const completedAt = t.completedAt ? ` · ✅ ${t.completedAt.slice(0, 10)}` : "";
      lines.push(`- [x] ~~${t.title}~~${completedAt}`);
      (t.subtasks ?? []).forEach(s => lines.push(`  - [x] ${s.title}`));
    });
  }

  return lines.join("\n");
}
