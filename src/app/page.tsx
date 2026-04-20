"use client";

import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import styles from "./page.module.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubtaskNode {
  id: string;
  title: string;
  done: boolean;
  children: SubtaskNode[];
  notes?: string;
}

interface Task {
  id: string;
  title: string;
  priority: "High" | "Medium" | "Low";
  category: string;
  done: boolean;
  archived?: boolean;
  createdAt: string;
  projectId: string;
  subtasks: SubtaskNode[];
  notes: string;
  eta: string;
  tagProjectIds: string[];
  deps: string[];
  recur: null;
  doneAt?: string;
  parentTaskId?: string | null;
  output?: string;
  dailyRank?: number;  // carry-over boost: incremented each day left incomplete on board
}

interface DailyBoard {
  date: string;       // "2026-03-24"
  taskIds: string[];  // ordered — index 0 = top priority
  wrapped: boolean;
}

interface ProjectBoard {
  id: string;
  name: string;         // user-defined, renameable
  projectId: string;
  date: string;         // user-chosen representative date
  createdAt: string;
  taskIds: string[];
  wrapped: boolean;
  wrappedAt?: string;
}

interface Project {
  id: string;
  name: string;
  notifyDiscord: boolean;
  private?: boolean;          // password-locked project
  passwordHash?: string;      // PBKDF2-SHA256 hex
  passwordSalt?: string;      // 16-byte random hex
  recoveryEmail?: string;     // email for forgot-password OTP
  lockSessionDays?: number;   // per-project notes-unlock TTL (overrides global default)
}
interface LearningTopic { id: string; name: string; addedAt: string; trackWeekly: boolean; lastSeenIds: string[]; }
interface BotJob {
  id: string;
  name: string;
  type: "digest" | "learning";
  cron: string;
  enabled: boolean;
  projectFilter?: string | null;      // null = all projects
  priorityFilter?: "All" | "High" | "Medium" | "Low";
}
interface Settings { jobs: BotJob[]; lockSessionDays?: number; etaWarningDays?: number; }
interface HubState {
  tasks: Task[];
  projects: Project[];
  learningTopics: LearningTopic[];
  settings?: Settings;
  dailyBoards?: DailyBoard[];
  projectBoards?: ProjectBoard[];
}

const STORE_KEY = "phub_v6";
const PROJECT_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444","#14b8a6"];

// Use local date (not UTC) so the board date matches the user's timezone.
function getLocalDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DEFAULT_JOBS: BotJob[] = [
  { id: "job_digest", name: "Daily Digest",     type: "digest",   cron: "0 10 * * 1-5", enabled: true, projectFilter: null, priorityFilter: "All" },
  { id: "job_learn",  name: "Friday Learning",  type: "learning", cron: "0 8 * * 5",    enabled: true },
];

function cronToHuman(expr: string): string {
  const known: Record<string, string> = {
    "0 10 * * 1-5": "10:00 am, Mon – Fri", "0 9 * * 1-5": "9:00 am, Mon – Fri",
    "0 8 * * 1-5":  "8:00 am, Mon – Fri",  "0 8 * * 5":   "8:00 am, every Friday",
    "0 7 * * 5":    "7:00 am, every Friday","0 9 * * 5":   "9:00 am, every Friday",
    "0 10 * * 5":   "10:00 am, every Friday",
  };
  return known[expr] ?? expr;
}

// ─── SubtaskNode helpers (pure) ───────────────────────────────────────────────

function countNodes(nodes: SubtaskNode[]): number {
  return (nodes ?? []).reduce((a, n) => a + 1 + countNodes(n.children ?? []), 0);
}
function countDoneNodes(nodes: SubtaskNode[]): number {
  return (nodes ?? []).reduce((a, n) => a + (n.done ? 1 : 0) + countDoneNodes(n.children ?? []), 0);
}
function updateNode(nodes: SubtaskNode[], id: string, fn: (n: SubtaskNode) => SubtaskNode): SubtaskNode[] {
  return (nodes ?? []).map(n => n.id === id ? fn(n) : { ...n, children: updateNode(n.children ?? [], id, fn) });
}
function removeNode(nodes: SubtaskNode[], id: string): SubtaskNode[] {
  return (nodes ?? []).filter(n => n.id !== id).map(n => ({ ...n, children: removeNode(n.children ?? [], id) }));
}
function findNode(nodes: SubtaskNode[], id: string): SubtaskNode | null {
  for (const n of nodes ?? []) {
    if (n.id === id) return n;
    const f = findNode(n.children ?? [], id);
    if (f) return f;
  }
  return null;
}
function insertNode(nodes: SubtaskNode[], targetId: string, node: SubtaskNode, pos: "before" | "after" | "child"): SubtaskNode[] {
  if (pos === "child") {
    return (nodes ?? []).map(n =>
      n.id === targetId
        ? { ...n, children: [...(n.children ?? []), node] }
        : { ...n, children: insertNode(n.children ?? [], targetId, node, pos) }
    );
  }
  const result: SubtaskNode[] = [];
  for (const n of nodes ?? []) {
    if (n.id === targetId && pos === "before") result.push(node);
    result.push({ ...n, children: insertNode(n.children ?? [], targetId, node, pos) });
    if (n.id === targetId && pos === "after") result.push(node);
  }
  return result;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function loadState(): Promise<HubState | null> {
  const res = await fetch(`/api/storage?key=${STORE_KEY}`);
  const { value } = await res.json();
  if (!value) return null;
  return JSON.parse(value) as HubState;
}
async function saveStateApi(state: HubState) {
  await fetch("/api/storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: STORE_KEY, value: JSON.stringify(state) }),
  });
}

// ─── Crypto helpers for project password locking ─────────────────────────────

function generateSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMat, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Board sort helpers (module-level so initial load can use them) ───────────

const BOARD_PRIO = { High: 3, Medium: 2, Low: 1 } as Record<string, number>;
function sortedBoardTaskIds(taskIds: string[], tasks: Task[], today = "", warningDays = 3): string[] {
  return [...taskIds].sort((a, b) => {
    const ta = tasks.find(t => t.id === a);
    const tb = tasks.find(t => t.id === b);
    if (!ta || !tb) return 0;
    if (ta.done !== tb.done) return ta.done ? 1 : -1;
    // ETA-imminent tasks float to top (before priority sort)
    const aImminent = today ? isEtaImminent(ta, today, warningDays) : false;
    const bImminent = today ? isEtaImminent(tb, today, warningDays) : false;
    if (aImminent !== bImminent) return aImminent ? -1 : 1;
    // Within imminent: sort by soonest ETA first
    if (aImminent && bImminent) {
      const da = daysUntilEta(ta.eta, today) ?? 999;
      const db = daysUntilEta(tb.eta, today) ?? 999;
      if (da !== db) return da - db;
    }
    return (BOARD_PRIO[tb.priority] ?? 0) - (BOARD_PRIO[ta.priority] ?? 0);
  });
}
function withSortedTodayBoard(boards: DailyBoard[], tasks: Task[], today: string, warningDays = 3): DailyBoard[] {
  return boards.map(b => b.date === today ? { ...b, taskIds: sortedBoardTaskIds(b.taskIds, tasks, today, warningDays) } : b);
}

/** Returns days until task's ETA. Negative = overdue. Null if no ETA set. */
function daysUntilEta(eta: string | undefined, today: string): number | null {
  if (!eta) return null;
  const etaMs = new Date(eta).getTime();
  const todayMs = new Date(today).getTime();
  return Math.round((etaMs - todayMs) / 86400000);
}

/** True if task ETA is within warningDays (or overdue). */
function isEtaImminent(task: Task, today: string, warningDays: number): boolean {
  const d = daysUntilEta(task.eta, today);
  return d !== null && d <= warningDays;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  // Computed client-side using local timezone — avoids UTC/server mismatch losing today's board on refresh
  const [todayStr] = useState<string>(getLocalDateStr);

  const [state, setState] = useState<HubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"tasks" | "today" | "boards" | "topics" | "settings">("tasks");
  const [filterProject, setFilterProject] = useState("all");
  const [filterDone, setFilterDone] = useState(false);
  const [filterArchived, setFilterArchived] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskNotes, setNewTaskNotes] = useState("");
  const [newTaskNotesOpen, setNewTaskNotesOpen] = useState(false);
  const [newTaskEta, setNewTaskEta] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<"High" | "Medium" | "Low">("Medium");
  const [newTaskProject, setNewTaskProject] = useState("");
  // Import
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPriority, setImportPriority] = useState<"High" | "Medium" | "Low">("Medium");
  const [importProject, setImportProject] = useState("");
  const [newTopicName, setNewTopicName] = useState("");

  // Task subtree collapse (tasks NOT in this set show their subtrees)
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  // Subtask node collapse (nodes IN this set hide their children)
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  // Adding subtask — null = closed
  const [addingSubFor, setAddingSubFor] = useState<{ taskId: string; parentNodeId: string | null } | null>(null);
  const [newSubText, setNewSubText] = useState("");

  // Notes
  const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null);

  // Project management
  const [newProjectName, setNewProjectName] = useState("");

  // Daily board task edit panel
  const [dailyEditTaskId, setDailyEditTaskId] = useState<string | null>(null);
  const [dailyEditTitle, setDailyEditTitle] = useState("");
  const [dailyEditNotes, setDailyEditNotes] = useState("");
  const [dailyEditParentId, setDailyEditParentId] = useState<string | null>(null);
  const [dailyEditEta, setDailyEditEta] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyTaskExpanded, setHistoryTaskExpanded] = useState<Set<string>>(new Set());

  // Board quick-add (in live board, not setup)
  const [boardQuickShow, setBoardQuickShow] = useState(false);
  const [boardQuickTitle, setBoardQuickTitle] = useState("");
  const [boardQuickPriority, setBoardQuickPriority] = useState<"High" | "Medium" | "Low">("Medium");

  // Inline title editing (daily board only)
  const [editingTitleFor, setEditingTitleFor] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState("");

  // Task card edit panel (main list — title + notes combined)
  const [taskEditOpenFor, setTaskEditOpenFor] = useState<string | null>(null);
  const [taskEditTitle, setTaskEditTitle] = useState("");
  const [taskEditNotes, setTaskEditNotes] = useState("");
  const [taskEditEta, setTaskEditEta] = useState("");
  const [taskEditProject, setTaskEditProject] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [notesExpandedFor, setNotesExpandedFor] = useState<Set<string>>(new Set());

  // Completion output
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [completionOutput, setCompletionOutput] = useState("");

  // Task DnD
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<"before" | "after">("after");

  // Subtask DnD
  const subDragNodeId = useRef<string | null>(null);
  const subDragTaskId = useRef<string | null>(null);
  const [subDropTarget, setSubDropTarget] = useState<{ nodeId: string; taskId: string; position: "before" | "after" | "child" } | null>(null);

  // Responsive layout detection
  const [isMobileAuto, setIsMobileAuto] = useState(false);
  const [isMobileOverride, setIsMobileOverride] = useState<boolean | null>(null); // null = follow auto
  const isMobile = isMobileOverride !== null ? isMobileOverride : isMobileAuto;
  useEffect(() => {
    const check = () => setIsMobileAuto(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Theme
  const [theme, setTheme] = useState<string>(() => typeof window !== "undefined" ? (localStorage.getItem("phub_theme") ?? "zinc") : "zinc");
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  useEffect(() => { localStorage.setItem("phub_theme", theme); }, [theme]);

  // Sync new-task project with current project filter
  useEffect(() => {
    if (filterProject !== "all") { setNewTaskProject(filterProject); setImportProject(filterProject); }
  }, [filterProject]);

  const THEMES = [
    { id: "zinc",   label: "Zinc",   swatch: "#2563eb" },
    { id: "dark",   label: "Dark",   swatch: "#6366f1" },
    { id: "warm",   label: "Warm",   swatch: "#d97706" },
    { id: "violet", label: "Violet", swatch: "#7c3aed" },
  ];

  // Private project lock / unlock — persisted in localStorage with TTL
  // Storage key → JSON: { [projectId]: unlockedUntilMs }
  const UNLOCK_STORE = "phub_unlocks";
  function readUnlockStore(): Record<string, number> {
    try { return JSON.parse(localStorage.getItem(UNLOCK_STORE) ?? "{}"); } catch { return {}; }
  }
  function writeUnlockStore(store: Record<string, number>) {
    localStorage.setItem(UNLOCK_STORE, JSON.stringify(store));
  }
  function getLockSessionMs(projectId?: string) {
    if (projectId) {
      const proj = state?.projects.find(p => p.id === projectId);
      if (proj?.lockSessionDays !== undefined) return proj.lockSessionDays * 24 * 60 * 60 * 1000;
    }
    const days = state?.settings?.lockSessionDays ?? 1;
    return days * 24 * 60 * 60 * 1000;
  }
  // Derive live unlocked set from localStorage (re-checked on each render via useMemo-like inline)
  const [unlockTick, setUnlockTick] = useState(0); // bump to force re-derive after lock/unlock
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unlockedProjects: Set<string> = (() => {
    void unlockTick; // depend on tick so React re-evaluates when it changes
    if (typeof window === "undefined") return new Set<string>();
    const now = Date.now();
    const store = readUnlockStore();
    return new Set(Object.entries(store).filter(([, exp]) => exp > now).map(([id]) => id));
  })();

  function persistUnlock(key: string, projectId?: string) {
    const store = readUnlockStore();
    store[key] = Date.now() + getLockSessionMs(projectId);
    writeUnlockStore(store);
    setUnlockTick(t => t + 1);
  }
  function persistLock(projectId: string) {
    const store = readUnlockStore();
    for (const key of Object.keys(store)) {
      if (key === projectId || key.startsWith(projectId + ":")) delete store[key];
    }
    writeUnlockStore(store);
    setUnlockTick(t => t + 1);
  }
  const [lockDialog, setLockDialog] = useState<{
    projectId: string;
    taskId?: string;           // set when unlocking a specific task's notes
    mode: "unlock" | "setPassword" | "changePassword" | "forgot" | "verifyOtp";
  } | null>(null);
  const [lockPassword, setLockPassword] = useState("");
  const [lockPasswordConfirm, setLockPasswordConfirm] = useState("");
  const [lockError, setLockError] = useState("");
  const [lockOtp, setLockOtp] = useState("");
  const [lockRecoveryEmail, setLockRecoveryEmail] = useState("");
  const [lockOtpLoading, setLockOtpLoading] = useState(false);

  // Backup / Restore
  const [restorePreview, setRestorePreview] = useState<HubState | null>(null);
  const [restoreFileName, setRestoreFileName] = useState("");
  const restoreInputRef = useRef<HTMLInputElement>(null);

  // Settings / Jobs
  const [jobs, setJobs] = useState<BotJob[]>(DEFAULT_JOBS);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editingJobDraft, setEditingJobDraft] = useState<BotJob | null>(null);
  const [addingJob, setAddingJob] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Search
  const [taskSearch, setTaskSearch] = useState("");
  const [dailySetupSearch, setDailySetupSearch] = useState("");

  // Daily board
  const [dailySetupSelected, setDailySetupSelected] = useState<Set<string>>(new Set());
  const [dailySetupFilter, setDailySetupFilter] = useState<"suggested" | "all">("suggested");
  const [dailySetupProjectId, setDailySetupProjectId] = useState<string>("memo");
  const [dailyAddingMore, setDailyAddingMore] = useState(false);
  const [dailyDragId, setDailyDragId] = useState<string | null>(null);
  const [dailyDragOverId, setDailyDragOverId] = useState<string | null>(null);
  const [dailyDragOverPos, setDailyDragOverPos] = useState<"before" | "after">("after");
  const [dailyNewTitle, setDailyNewTitle] = useState("");
  const [dailyNewNotes, setDailyNewNotes] = useState("");
  const [dailyNewPriority, setDailyNewPriority] = useState<"High" | "Medium" | "Low">("High");
  const [dailyShowNewForm, setDailyShowNewForm] = useState(false);
  // Subtask node inline editing
  const [editingSubNodeId, setEditingSubNodeId] = useState<string | null>(null);
  const [editingSubNodeTitle, setEditingSubNodeTitle] = useState("");
  const [subNodeNotesId, setSubNodeNotesId] = useState<string | null>(null);
  const [subNodeNotesDraft, setSubNodeNotesDraft] = useState("");
  // Today board: which task's subtasks are expanded
  const [boardSubExpanded, setBoardSubExpanded] = useState<Set<string>>(new Set());

  // Wrap-up flow
  const [wrapMode, setWrapMode] = useState(false);
  const [wrapResolveIds, setWrapResolveIds] = useState<Set<string>>(new Set());
  const [wrapCarryIds, setWrapCarryIds] = useState<Set<string>>(new Set());
  // Show setup screen after wrap-up or when user clicks "Start New Board"
  const [dailyShowSetup, setDailyShowSetup] = useState(false);
  const setupAutoSelectDone = useRef(false);

  // ── Project boards state ────────────────────────────────────────────────────
  const [pbView, setPbView] = useState<"list" | "setup" | "detail">("list");
  const [pbSelectedId, setPbSelectedId] = useState<string | null>(null);
  const [pbSetupName, setPbSetupName] = useState("");
  const [pbSetupDate, setPbSetupDate] = useState(todayStr);
  const [pbSetupProjectId, setPbSetupProjectId] = useState("");
  const [pbSetupSelected, setPbSetupSelected] = useState<Set<string>>(new Set());
  const [pbSetupSearch, setPbSetupSearch] = useState("");
  const [pbRenamingId, setPbRenamingId] = useState<string | null>(null);
  const [pbRenameDraft, setPbRenameDraft] = useState("");
  const [pbEditingDate, setPbEditingDate] = useState<string | null>(null);
  const [pbDateDraft, setPbDateDraft] = useState("");
  const [pbWrapMode, setPbWrapMode] = useState(false);
  const [pbWrapResolveIds, setPbWrapResolveIds] = useState<Set<string>>(new Set());
  const [pbWrapCarryIds, setPbWrapCarryIds] = useState<Set<string>>(new Set());
  const [pbShowWrapped, setPbShowWrapped] = useState(false);
  const [pbFilterProjectId, setPbFilterProjectId] = useState<string>("all"); // "all" or a project id

  useEffect(() => {
    loadState().then((s) => {
      // Ensure seed projects exist
      const seedProjects: Project[] = [
        { id: "p_learning", name: "Learning", notifyDiscord: false },
        { id: "p_newideas", name: "New Ideas", notifyDiscord: false },
      ];
      let projectsChanged = false;
      for (const sp of seedProjects) {
        if (s && !(s.projects ?? []).find((p: Project) => p.id === sp.id || p.name === sp.name)) {
          s = { ...s, projects: [...(s.projects ?? []), sp] };
          projectsChanged = true;
        }
      }
      if (projectsChanged && s) saveStateApi(s);
      // Sort today's board on load so initial display is always ordered
      if (s?.dailyBoards) s = { ...s, dailyBoards: withSortedTodayBoard(s.dailyBoards, s.tasks ?? [], getLocalDateStr()) };
      setState(s);
      if (s?.projects?.[0]) setNewTaskProject(s.projects[0].id);
      if (s?.settings) {
        const e = s.settings as Record<string, unknown>;
        if (Array.isArray(e.jobs) && e.jobs.length > 0) {
          setJobs(e.jobs as BotJob[]);
        } else {
          // Migrate legacy digestCron/learnCron format
          const migrated = DEFAULT_JOBS.map(j => ({ ...j }));
          if (e.digestCron) migrated[0] = { ...migrated[0], cron: e.digestCron as string };
          if (e.learnCron)  migrated[1] = { ...migrated[1], cron: e.learnCron  as string };
          setJobs(migrated);
        }
      }
      setLoading(false);
    });
  }, []);

  // Save queue — ensures the LATEST state always wins even if persists overlap.
  // Without this, two rapid persists (e.g. wrap-up then new board) can race;
  // whichever API call finishes last wins and the other's changes are lost on refresh.
  const pendingSave = useRef<HubState | null>(null);
  const isSaving = useRef(false);

  const persist = useCallback(async (next: HubState) => {
    setState(next);
    setSaving(true);
    pendingSave.current = next;
    if (isSaving.current) return; // drain loop will pick up the latest
    isSaving.current = true;
    while (pendingSave.current) {
      const toSave = pendingSave.current;
      pendingSave.current = null;
      await saveStateApi(toSave);
    }
    isSaving.current = false;
    setSaving(false);
  }, []);

  // ── Task CRUD ────────────────────────────────────────────────────────────────

  function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !importText.trim()) return;
    const projectId = importProject || (state.projects?.[0]?.id ?? "p_default");
    const today = new Date().toISOString().slice(0, 10);
    const newTasks: Task[] = importText
      .split("\n")
      .map(line => line.replace(/^[-*•]\s*/, "").trim())
      .filter(line => line.length > 0)
      .map(title => ({
        id: Math.random().toString(36).slice(2, 9), title,
        priority: importPriority, category: "Other", done: false,
        createdAt: today, projectId,
        subtasks: [], notes: "", eta: "", tagProjectIds: [], deps: [], recur: null,
      }));
    if (!newTasks.length) return;
    persist({ ...state, tasks: [...newTasks, ...state.tasks] });
    setImportText("");
    setImportOpen(false);
  }

  function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !newTaskTitle.trim()) return;
    const task: Task = {
      id: Math.random().toString(36).slice(2, 9), title: newTaskTitle.trim(),
      priority: newTaskPriority, category: "Other", done: false,
      createdAt: new Date().toISOString().slice(0, 10),
      projectId: newTaskProject || (state.projects?.[0]?.id ?? "p_default"),
      subtasks: [], notes: newTaskNotes.trim(), eta: newTaskEta, tagProjectIds: [], deps: [], recur: null,
    };
    persist({ ...state, tasks: [task, ...state.tasks] });
    setNewTaskTitle("");
    setNewTaskNotes("");
    setNewTaskEta("");
    setNewTaskNotesOpen(false);
  }
  function handleToggleDone(taskId: string) {
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (!task.done) {
      // Opening → show completion form
      setCompletingTaskId(taskId); setCompletionOutput("");
    } else {
      // Uncheck → skip form, just mark active
      const updatedTasks = state.tasks.map(t =>
        t.id === taskId ? { ...t, done: false, doneAt: undefined } : t
      );
      persist({ ...state, tasks: updatedTasks, dailyBoards: withSortedTodayBoard(state.dailyBoards ?? [], updatedTasks, todayStr, state.settings?.etaWarningDays ?? 3) });
    }
  }
  function confirmComplete(taskId: string, skipOutput = false) {
    if (!state) return;
    const updatedTasks = state.tasks.map(t =>
      t.id === taskId ? { ...t, done: true, doneAt: new Date().toISOString(), output: skipOutput ? t.output : (completionOutput.trim() || t.output) } : t
    );
    persist({ ...state, tasks: updatedTasks, dailyBoards: withSortedTodayBoard(state.dailyBoards ?? [], updatedTasks, todayStr, state.settings?.etaWarningDays ?? 3) });
    setCompletingTaskId(null); setCompletionOutput("");
  }
  function handleDeleteTask(taskId: string) {
    if (!state) return;
    // Soft-delete: archive the task (and its children). Recoverable from the Archived view.
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id === taskId || t.parentTaskId === taskId ? { ...t, archived: true } : t
    )});
  }
  function handleRestoreTask(taskId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id === taskId || t.parentTaskId === taskId ? { ...t, archived: false } : t
    )});
  }
  function handlePermanentDeleteTask(taskId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.filter(t => t.id !== taskId && t.parentTaskId !== taskId) });
  }

  // ── Task DnD ─────────────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, taskId: string) {
    setDragId(taskId); e.dataTransfer.effectAllowed = "move";
  }
  function handleDragOver(e: React.DragEvent, taskId: string) {
    e.preventDefault(); if (taskId === dragId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDragOverId(taskId); setDragOverPos(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
  }
  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || !state || dragId === targetId) { setDragId(null); setDragOverId(null); return; }
    const all = [...state.tasks];
    const [moved] = all.splice(all.findIndex(t => t.id === dragId), 1);
    const ti = all.findIndex(t => t.id === targetId);
    all.splice(dragOverPos === "before" ? ti : ti + 1, 0, moved);
    persist({ ...state, tasks: all });
    setDragId(null); setDragOverId(null);
  }
  function handleDragEnd() { setDragId(null); setDragOverId(null); }

  // ── Subtask CRUD ─────────────────────────────────────────────────────────────

  function handleAddSubtask() {
    if (!addingSubFor || !newSubText.trim() || !state) return;
    const node: SubtaskNode = { id: Math.random().toString(36).slice(2, 9), title: newSubText.trim(), done: false, children: [] };
    const { taskId, parentNodeId } = addingSubFor;
    persist({
      ...state,
      tasks: state.tasks.map(t => {
        if (t.id !== taskId) return t;
        if (!parentNodeId) return { ...t, subtasks: [...(t.subtasks ?? []), node] };
        return { ...t, subtasks: updateNode(t.subtasks ?? [], parentNodeId, n => ({ ...n, children: [...(n.children ?? []), node] })) };
      }),
    });
    setNewSubText(""); setAddingSubFor(null);
  }
  function handleToggleSubtask(taskId: string, nodeId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id !== taskId ? t : { ...t, subtasks: updateNode(t.subtasks ?? [], nodeId, n => ({ ...n, done: !n.done })) }
    )});
  }
  function handleDeleteSubtask(taskId: string, nodeId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id !== taskId ? t : { ...t, subtasks: removeNode(t.subtasks ?? [], nodeId) }
    )});
  }

  function openSubNodeEdit(taskId: string, node: SubtaskNode) {
    setEditingSubNodeId(node.id);
    setEditingSubNodeTitle(node.title);
    setSubNodeNotesDraft(node.notes ?? "");
    setSubNodeNotesId(null);
  }

  function saveSubNodeEdit(taskId: string, nodeId: string) {
    if (!state || !editingSubNodeTitle.trim()) { setEditingSubNodeId(null); return; }
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id !== taskId ? t : { ...t, subtasks: updateNode(t.subtasks ?? [], nodeId, n => ({ ...n, title: editingSubNodeTitle.trim(), notes: subNodeNotesDraft })) }
    )});
    setEditingSubNodeId(null);
  }

  // ── Subtask DnD ──────────────────────────────────────────────────────────────

  function handleSubDragStart(e: React.DragEvent, taskId: string, nodeId: string) {
    subDragNodeId.current = nodeId; subDragTaskId.current = taskId;
    e.dataTransfer.effectAllowed = "move"; e.stopPropagation();
  }
  function handleSubDragOver(e: React.DragEvent, taskId: string, nodeId: string) {
    e.preventDefault(); e.stopPropagation();
    if (nodeId === subDragNodeId.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    const position = relY < 0.28 ? "before" : relY > 0.72 ? "after" : "child";
    setSubDropTarget({ nodeId, taskId, position });
  }
  function handleSubDrop(e: React.DragEvent, taskId: string) {
    e.preventDefault(); e.stopPropagation();
    const draggedId = subDragNodeId.current;
    if (!draggedId || !subDropTarget || !state || subDropTarget.taskId !== taskId) {
      subDragNodeId.current = null; setSubDropTarget(null); return;
    }
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const dragged = findNode(task.subtasks ?? [], draggedId);
    if (!dragged) return;
    // Prevent dropping into own descendant
    if (findNode([dragged], subDropTarget.nodeId)) { subDragNodeId.current = null; setSubDropTarget(null); return; }
    const without = removeNode(task.subtasks ?? [], draggedId);
    const inserted = insertNode(without, subDropTarget.nodeId, dragged, subDropTarget.position);
    persist({ ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, subtasks: inserted } : t) });
    subDragNodeId.current = null; subDragTaskId.current = null; setSubDropTarget(null);
  }
  function handleSubDragEnd() { subDragNodeId.current = null; subDragTaskId.current = null; setSubDropTarget(null); }

  // ── Notes ─────────────────────────────────────────────────────────────────────

  function openNotes(task: Task) { setNotesOpenFor(task.id); setNotesDraft(task.notes ?? ""); }
  function saveNotes(taskId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, notes: notesDraft } : t) });
    setNotesOpenFor(null);
  }

  // ── Projects ──────────────────────────────────────────────────────────────────

  function handleAddProject(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !newProjectName.trim()) return;
    const name = newProjectName.trim();
    if ((state.projects ?? []).some(p => p.name.toLowerCase() === name.toLowerCase())) return;
    const proj: Project = { id: Math.random().toString(36).slice(2, 9), name, notifyDiscord: false };
    persist({ ...state, projects: [...(state.projects ?? []), proj] });
    setNewProjectName("");
  }

  function handleDeleteProject(projectId: string) {
    if (!state) return;
    persist({ ...state, projects: (state.projects ?? []).filter(p => p.id !== projectId) });
  }

  // ── Daily board task edit ──────────────────────────────────────────────────────

  function openDailyTaskEdit(task: Task) {
    setDailyEditTaskId(task.id);
    setDailyEditTitle(task.title);
    setDailyEditNotes(task.notes ?? "");
    setDailyEditParentId(task.parentTaskId ?? null);
    setDailyEditEta(task.eta ?? "");
  }

  function saveDailyTaskEdit() {
    if (!state || !dailyEditTaskId || !dailyEditTitle.trim()) { setDailyEditTaskId(null); return; }
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id === dailyEditTaskId ? { ...t, title: dailyEditTitle.trim(), notes: dailyEditNotes, parentTaskId: dailyEditParentId, eta: dailyEditEta } : t
    )});
    setDailyEditTaskId(null);
  }

  // ── Topics ───────────────────────────────────────────────────────────────────

  function handleAddTopic(e: React.FormEvent) {
    e.preventDefault(); if (!state || !newTopicName.trim()) return;
    const topics = state.learningTopics ?? [];
    if (topics.some(t => t.name.toLowerCase() === newTopicName.toLowerCase())) return;
    persist({ ...state, learningTopics: [{ id: Math.random().toString(36).slice(2, 9), name: newTopicName.trim(), addedAt: new Date().toISOString().slice(0, 10), trackWeekly: true, lastSeenIds: [] }, ...topics] });
    setNewTopicName("");
  }
  function handleToggleTracking(id: string) {
    if (!state) return;
    persist({ ...state, learningTopics: (state.learningTopics ?? []).map(t => t.id === id ? { ...t, trackWeekly: !t.trackWeekly } : t) });
  }
  function handleDeleteTopic(id: string) {
    if (!state) return;
    persist({ ...state, learningTopics: (state.learningTopics ?? []).filter(t => t.id !== id) });
  }

  // ── Private project lock / unlock ────────────────────────────────────────────

  function openLockDialog(projectId: string, mode: "unlock" | "setPassword" | "changePassword" | "forgot" | "verifyOtp", taskId?: string) {
    setLockDialog({ projectId, mode, taskId });
    setLockPassword(""); setLockPasswordConfirm(""); setLockError(""); setLockOtp(""); setLockOtpLoading(false);
    const proj = state?.projects.find(p => p.id === projectId);
    setLockRecoveryEmail(proj?.recoveryEmail ?? "");
  }

  async function handleSetProjectPassword() {
    if (!state || !lockDialog) return;
    if (lockPassword.length < 4) { setLockError("Password must be at least 4 characters."); return; }
    if (lockPassword !== lockPasswordConfirm) { setLockError("Passwords don't match."); return; }
    const salt = generateSalt();
    const hash = await hashPassword(lockPassword, salt);
    const updated = state.projects.map(p =>
      p.id === lockDialog.projectId
        ? { ...p, private: true, passwordHash: hash, passwordSalt: salt, recoveryEmail: lockRecoveryEmail || p.recoveryEmail }
        : p
    );
    await persist({ ...state, projects: updated });
    persistUnlock(lockDialog.projectId, lockDialog.projectId);
    setLockDialog(null);
  }

  async function handleUnlockProject() {
    if (!state || !lockDialog) return;
    const proj = state.projects.find(p => p.id === lockDialog.projectId);
    if (!proj?.passwordHash || !proj?.passwordSalt) { setLockError("No password set."); return; }
    const hash = await hashPassword(lockPassword, proj.passwordSalt);
    if (hash !== proj.passwordHash) { setLockError("Incorrect password."); return; }
    const pid = lockDialog.projectId;
    if (lockDialog.taskId) {
      // Unlock notes for a single task
      persistUnlock(`${pid}:${lockDialog.taskId}`, pid);
    } else {
      // Unlock all notes in project
      persistUnlock(pid, pid);
      setFilterProject(pid);
      if (tab !== "tasks") setTab("tasks");
    }
    setLockDialog(null);
  }

  function handleLockProject(projectId: string) {
    persistLock(projectId);
  }

  async function handleRemoveProjectPassword() {
    if (!state || !lockDialog) return;
    const updated = state.projects.map(p =>
      p.id === lockDialog.projectId
        ? { ...p, private: false, passwordHash: undefined, passwordSalt: undefined }
        : p
    );
    await persist({ ...state, projects: updated });
    persistLock(lockDialog.projectId);
    setLockDialog(null);
  }

  async function handleSendOtp() {
    if (!state || !lockDialog) return;
    const proj = state.projects.find(p => p.id === lockDialog.projectId);
    const email = lockRecoveryEmail || proj?.recoveryEmail;
    if (!email) { setLockError("No recovery email set for this project."); return; }
    setLockOtpLoading(true); setLockError("");
    try {
      const res = await fetch("/api/auth-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", projectId: lockDialog.projectId, email }),
      });
      if (!res.ok) throw new Error(await res.text());
      setLockDialog({ ...lockDialog, mode: "verifyOtp" });
      setLockRecoveryEmail(email);
    } catch (e) {
      setLockError("Failed to send code: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLockOtpLoading(false);
    }
  }

  async function handleVerifyOtp() {
    if (!state || !lockDialog) return;
    if (lockPassword.length < 4) { setLockError("New password must be at least 4 characters."); return; }
    if (lockPassword !== lockPasswordConfirm) { setLockError("Passwords don't match."); return; }
    setLockOtpLoading(true); setLockError("");
    try {
      const res = await fetch("/api/auth-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", projectId: lockDialog.projectId, otp: lockOtp }),
      });
      if (!res.ok) throw new Error(await res.text());
      const salt = generateSalt();
      const hash = await hashPassword(lockPassword, salt);
      const updated = state.projects.map(p =>
        p.id === lockDialog.projectId ? { ...p, passwordHash: hash, passwordSalt: salt } : p
      );
      await persist({ ...state, projects: updated });
      persistUnlock(lockDialog.projectId!, lockDialog.projectId!);
      setLockDialog(null);
    } catch (e) {
      setLockError("Invalid or expired code.");
    } finally {
      setLockOtpLoading(false);
    }
  }

  // ── Backup / Restore ─────────────────────────────────────────────────────────

  function handleExport() {
    if (!state) return;
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flowdesk-backup-${todayStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleRestoreFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as HubState;
        if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.projects)) throw new Error("Invalid");
        setRestorePreview(parsed);
        setRestoreFileName(file.name);
      } catch {
        alert("Invalid backup file — please choose a valid FlowDesk JSON backup.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function confirmRestore() {
    if (!restorePreview) return;
    await persist(restorePreview);
    setRestorePreview(null);
    setRestoreFileName("");
  }

  // ── Settings / Jobs ──────────────────────────────────────────────────────────

  async function handleSaveJobs() {
    if (!state) return;
    await persist({ ...state, settings: { jobs } });
    setSettingsSaved(true); setTimeout(() => setSettingsSaved(false), 2500);
  }

  function startEditJob(job: BotJob) {
    setEditingJobId(job.id); setEditingJobDraft({ ...job }); setAddingJob(false);
  }
  function cancelJobEdit() {
    setEditingJobId(null); setEditingJobDraft(null); setAddingJob(false);
  }
  function saveEditJob() {
    if (!editingJobDraft) return;
    if (addingJob) setJobs(prev => [...prev, editingJobDraft]);
    else setJobs(prev => prev.map(j => j.id === editingJobDraft.id ? editingJobDraft : j));
    cancelJobEdit();
  }
  function startAddJob() {
    const newJob: BotJob = { id: Math.random().toString(36).slice(2, 9), name: "New Job", type: "digest", cron: "0 9 * * 1-5", enabled: true, projectFilter: null, priorityFilter: "All" };
    setEditingJobDraft(newJob); setEditingJobId(null); setAddingJob(true);
  }
  function toggleJobEnabled(jobId: string) {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, enabled: !j.enabled } : j));
  }
  function deleteJob(jobId: string) {
    setJobs(prev => prev.filter(j => j.id !== jobId));
  }

  // ── Project boards ────────────────────────────────────────────────────────────

  function goToProjectBoards(projectId: string) {
    setPbFilterProjectId(projectId);
    setTab("boards");
    setPbView("list");
  }

  function openPbSetup(projectId?: string) {
    if (!state) return;
    const pid = projectId ?? (state.projects[0]?.id ?? "");
    const existingCount = (state.projectBoards ?? []).filter(b => b.projectId === pid).length;
    const proj = state.projects.find(p => p.id === pid);
    setPbSetupProjectId(pid);
    setPbSetupName(`${proj?.name ?? "Board"} Sprint ${existingCount + 1}`);
    setPbSetupDate(todayStr);
    setPbSetupSelected(new Set());
    setPbSetupSearch("");
    setPbView("setup");
  }

  function confirmPbSetup() {
    if (!state || pbSetupSelected.size === 0 || !pbSetupName.trim()) return;
    const board: ProjectBoard = {
      id: Math.random().toString(36).slice(2, 9),
      name: pbSetupName.trim(),
      projectId: pbSetupProjectId,
      date: pbSetupDate,
      createdAt: new Date().toISOString(),
      taskIds: [...pbSetupSelected],
      wrapped: false,
    };
    persist({ ...state, projectBoards: [...(state.projectBoards ?? []), board] });
    setPbSelectedId(board.id);
    setPbView("detail");
  }

  function openPbDetail(boardId: string) {
    setPbSelectedId(boardId);
    setPbWrapMode(false);
    setPbView("detail");
  }

  function deletePb(boardId: string) {
    if (!state) return;
    persist({ ...state, projectBoards: (state.projectBoards ?? []).filter(b => b.id !== boardId) });
    if (pbSelectedId === boardId) { setPbSelectedId(null); setPbView("list"); }
  }

  function savePbRename(boardId: string) {
    if (!state || !pbRenameDraft.trim()) { setPbRenamingId(null); return; }
    persist({ ...state, projectBoards: (state.projectBoards ?? []).map(b => b.id === boardId ? { ...b, name: pbRenameDraft.trim() } : b) });
    setPbRenamingId(null);
  }

  function savePbDate(boardId: string) {
    if (!state || !pbDateDraft) { setPbEditingDate(null); return; }
    persist({ ...state, projectBoards: (state.projectBoards ?? []).map(b => b.id === boardId ? { ...b, date: pbDateDraft } : b) });
    setPbEditingDate(null);
  }

  function togglePbTask(taskId: string) {
    if (!state || !pbSelectedId) return;
    persist({ ...state, projectBoards: (state.projectBoards ?? []).map(b =>
      b.id !== pbSelectedId ? b : {
        ...b,
        taskIds: b.taskIds.includes(taskId) ? b.taskIds.filter(id => id !== taskId) : [...b.taskIds, taskId],
      }
    )});
  }

  function openPbWrapUp() {
    if (!state || !pbSelectedId) return;
    const board = (state.projectBoards ?? []).find(b => b.id === pbSelectedId);
    if (!board) return;
    const doneIds = board.taskIds.filter(id => state.tasks.find(t => t.id === id)?.done);
    const incompleteIds = board.taskIds.filter(id => !state.tasks.find(t => t.id === id)?.done);
    setPbWrapResolveIds(new Set());
    setPbWrapCarryIds(new Set(incompleteIds));
    setPbWrapMode(true);
  }

  function confirmPbWrapUp() {
    if (!state || !pbSelectedId) return;
    const now = new Date().toISOString();
    const updatedTasks = state.tasks.map(t => {
      if (pbWrapResolveIds.has(t.id)) return { ...t, done: true, doneAt: t.doneAt ?? now };
      if (pbWrapCarryIds.has(t.id)) return { ...t, dailyRank: (t.dailyRank ?? 0) + 1 };
      return t;
    });
    const updatedBoards = (state.projectBoards ?? []).map(b =>
      b.id === pbSelectedId ? { ...b, wrapped: true, wrappedAt: now } : b
    );
    persist({ ...state, tasks: updatedTasks, projectBoards: updatedBoards });
    setPbWrapMode(false);
  }

  function togglePbWrapId(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function togglePbTaskDone(taskId: string) {
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const updatedTasks = task.done
      ? state.tasks.map(t => t.id === taskId ? { ...t, done: false, doneAt: undefined } : t)
      : state.tasks.map(t => t.id === taskId ? { ...t, done: true, doneAt: new Date().toISOString() } : t);
    persist({ ...state, tasks: updatedTasks, dailyBoards: withSortedTodayBoard(state.dailyBoards ?? [], updatedTasks, todayStr, state.settings?.etaWarningDays ?? 3) });
  }

  // ── Daily board ───────────────────────────────────────────────────────────────

  function getDefaultBoardSelection(tasks: Task[], boards: DailyBoard[], projects: Project[]): Set<string> {
    const prevBoard = [...boards]
      .filter(b => b.date < todayStr)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const prevBoardIds = new Set(prevBoard?.taskIds ?? []);
    // Default view is the Memo project — only pre-select tasks visible there
    const memoId = projects.find(p => p.name === "Memo")?.id ?? null;
    return new Set(
      tasks
        .filter(t => !t.done
          && (memoId ? t.projectId === memoId : true)
          && prevBoardIds.has(t.id))
        .map(t => t.id)
    );
  }

  // Auto-select defaults when setup screen opens for a genuinely new day (no board for todayStr).
  // If today's board exists (even wrapped), we don't auto-populate — user is adding more.
  useEffect(() => {
    const hasBoard = !!(state?.dailyBoards?.find(b => b.date === todayStr));
    if (!state || tab !== "today" || hasBoard || dailyAddingMore || dailyShowSetup) {
      setupAutoSelectDone.current = false;
      return;
    }
    if (setupAutoSelectDone.current) return;
    setupAutoSelectDone.current = true;
    setDailySetupSelected(getDefaultBoardSelection(state.tasks, state.dailyBoards ?? [], state.projects));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dailyAddingMore, dailyShowSetup]);

  function switchToToday() {
    setTab("today");
    setDailySetupSearch("");
  }

  function confirmDailySetup() {
    if (!state || dailySetupSelected.size === 0) return;
    const board = state.dailyBoards?.find(b => b.date === todayStr);
    if (board) {
      // Always MERGE into the existing board for today — one board per day.
      // Un-wrap it (it's active again) and add any newly selected tasks.
      const existing = new Set(board.taskIds);
      const added = [...dailySetupSelected].filter(id => !existing.has(id));
      const merged = sortedBoardTaskIds([...board.taskIds, ...added], state.tasks, todayStr, state.settings?.etaWarningDays ?? 3);
      persist({ ...state, dailyBoards: (state.dailyBoards ?? []).map(b => b.date === todayStr ? { ...b, taskIds: merged, wrapped: false } : b) });
    } else {
      // Genuinely new day — create fresh board.
      const newBoard: DailyBoard = { date: todayStr, taskIds: sortedBoardTaskIds([...dailySetupSelected], state.tasks, todayStr, state.settings?.etaWarningDays ?? 3), wrapped: false };
      persist({ ...state, dailyBoards: [...(state.dailyBoards ?? []), newBoard] });
    }
    setDailyAddingMore(false);
    setDailyShowSetup(false);
  }

  function openWrapUp() {
    if (!state) return;
    const board = state.dailyBoards?.find(b => b.date === todayStr);
    if (!board) return;
    const incompleteIds = board.taskIds.filter(id => !state.tasks.find(t => t.id === id)?.done);
    setWrapResolveIds(new Set()); // user must opt in to resolving completed tasks
    setWrapCarryIds(new Set(incompleteIds));
    setWrapMode(true);
  }

  function confirmWrapUp() {
    if (!state) return;
    const now = new Date().toISOString();
    const updatedTasks = state.tasks.map(t => {
      if (wrapResolveIds.has(t.id)) return { ...t, done: true, doneAt: t.doneAt ?? now };
      if (wrapCarryIds.has(t.id)) return { ...t, dailyRank: (t.dailyRank ?? 0) + 1 };
      return t;
    });
    // Mark today's board wrapped — it stays as the single board for this date.
    const updatedBoards = (state.dailyBoards ?? []).map(b => b.date === todayStr ? { ...b, wrapped: true } : b);
    persist({ ...state, tasks: updatedTasks, dailyBoards: updatedBoards });
    setWrapMode(false);
    // Stay on the board view — user can add more tasks via "Add more" if needed.
    // No automatic setup screen; setup only appears for a genuinely new day.
  }

  function toggleWrapId(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function handleUpdatePriority(taskId: string, current: "High" | "Medium" | "Low") {
    if (!state) return;
    const next: "High" | "Medium" | "Low" = current === "High" ? "Medium" : current === "Medium" ? "Low" : "High";
    const updatedTasks = state.tasks.map(t => t.id === taskId ? { ...t, priority: next } : t);
    persist({ ...state, tasks: updatedTasks, dailyBoards: withSortedTodayBoard(state.dailyBoards ?? [], updatedTasks, todayStr, state.settings?.etaWarningDays ?? 3) });
  }

  function removeDailyTask(taskId: string) {
    if (!state) return;
    persist({ ...state, dailyBoards: (state.dailyBoards ?? []).map(b => b.date === todayStr ? { ...b, taskIds: b.taskIds.filter(id => id !== taskId) } : b) });
  }

  function deboostTask(taskId: string) {
    if (!state) return;
    persist({ ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, dailyRank: 0 } : t) });
  }

  function startAddMore() {
    setDailySetupSelected(new Set());
    setDailyAddingMore(true);
  }

  function handleDailyDragStart(e: React.DragEvent, taskId: string) {
    setDailyDragId(taskId); e.dataTransfer.effectAllowed = "move";
  }
  function handleDailyDragOver(e: React.DragEvent, taskId: string) {
    e.preventDefault(); if (taskId === dailyDragId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDailyDragOverId(taskId);
    setDailyDragOverPos(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
  }
  function handleDailyDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (!dailyDragId || !state || dailyDragId === targetId) { setDailyDragId(null); setDailyDragOverId(null); return; }
    const board = state.dailyBoards?.find(b => b.date === todayStr);
    if (!board) return;
    const ids = [...board.taskIds];
    ids.splice(ids.indexOf(dailyDragId), 1);
    const ti = ids.indexOf(targetId);
    ids.splice(dailyDragOverPos === "before" ? ti : ti + 1, 0, dailyDragId);
    persist({ ...state, dailyBoards: (state.dailyBoards ?? []).map(b => b.date === todayStr ? { ...b, taskIds: ids } : b) });
    setDailyDragId(null); setDailyDragOverId(null);
  }
  function handleDailyDragEnd() { setDailyDragId(null); setDailyDragOverId(null); }

  function handleDailyNewTask(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !dailyNewTitle.trim()) return;
    const memoProj = (state.projects ?? []).find((p: Project) => p.name === "Memo");
    const id = Math.random().toString(36).slice(2, 9);
    const task: Task = {
      id, title: dailyNewTitle.trim(), priority: dailyNewPriority, category: "Other",
      done: false, createdAt: new Date().toISOString().slice(0, 10),
      projectId: memoProj?.id ?? newTaskProject ?? (state.projects?.[0]?.id ?? "p_default"),
      subtasks: [], notes: dailyNewNotes.trim(), eta: "", tagProjectIds: [], deps: [], recur: null,
    };
    persist({ ...state, tasks: [task, ...state.tasks] });
    setDailySetupSelected(prev => new Set([...prev, id]));
    setDailyNewTitle(""); setDailyNewNotes(""); setDailyShowNewForm(false);
  }

  function handleBoardQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !boardQuickTitle.trim()) return;
    const memoProj = (state.projects ?? []).find((p: Project) => p.name === "Memo");
    const id = Math.random().toString(36).slice(2, 9);
    const task: Task = {
      id, title: boardQuickTitle.trim(), priority: boardQuickPriority, category: "Other",
      done: false, createdAt: new Date().toISOString().slice(0, 10),
      projectId: memoProj?.id ?? (state.projects?.[0]?.id ?? "p_default"),
      subtasks: [], notes: "", eta: "", tagProjectIds: [], deps: [], recur: null,
    };
    const allTasks = [...state.tasks, task];
    const updatedBoards = (state.dailyBoards ?? []).map(b =>
      b.date === todayStr ? { ...b, taskIds: sortedBoardTaskIds([...b.taskIds, id], allTasks, todayStr, state.settings?.etaWarningDays ?? 3) } : b
    );
    persist({ ...state, tasks: allTasks, dailyBoards: updatedBoards });
    setBoardQuickTitle(""); setBoardQuickShow(false);
  }

  function saveTaskTitle(taskId: string) {
    if (!state || !editingTitleDraft.trim()) { setEditingTitleFor(null); return; }
    persist({ ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, title: editingTitleDraft.trim() } : t) });
    setEditingTitleFor(null);
  }

  function openTaskEdit(task: Task) {
    setTaskEditOpenFor(task.id);
    setTaskEditTitle(task.title);
    setTaskEditNotes(task.notes ?? "");
    setTaskEditEta(task.eta ?? "");
    setTaskEditProject(task.projectId ?? "");
    setNotesOpenFor(null); // close standalone notes panel if open
  }

  function saveTaskEdit(taskId: string) {
    if (!state || !taskEditTitle.trim()) { setTaskEditOpenFor(null); return; }
    persist({ ...state, tasks: state.tasks.map(t =>
      t.id === taskId ? { ...t, title: taskEditTitle.trim(), notes: taskEditNotes, eta: taskEditEta, projectId: taskEditProject || t.projectId } : t
    )});
    setTaskEditOpenFor(null);
  }

  function toggleDailySetupTask(taskId: string, parentTaskId?: string | null) {
    setDailySetupSelected(prev => {
      const n = new Set(prev);
      if (n.has(taskId)) {
        n.delete(taskId);
      } else {
        n.add(taskId);
        // Auto-select parent when child is selected
        if (parentTaskId) n.add(parentTaskId);
      }
      return n;
    });
  }

  // ── Recursive subtask renderer ────────────────────────────────────────────────

  function renderSubtree(nodes: SubtaskNode[], taskId: string, depth: number): React.ReactNode {
    if (!nodes?.length) return null;
    const parentTask = state!.tasks.find(t => t.id === taskId);
    const notesLocked = parentTask ? isTaskNotesLocked(parentTask) : false;
    return nodes.map(node => {
      const children = node.children ?? [];
      const hasChildren = children.length > 0;
      const isNodeCollapsed = collapsedNodes.has(node.id);
      const childCount = countNodes(children);
      const childDoneCount = countDoneNodes(children);
      const st = subDropTarget;
      const isDropBefore = st?.nodeId === node.id && st.position === "before" && st.taskId === taskId;
      const isDropAfter  = st?.nodeId === node.id && st.position === "after"  && st.taskId === taskId;
      const isDropChild  = st?.nodeId === node.id && st.position === "child"  && st.taskId === taskId;

      return (
        <Fragment key={node.id}>
          {isDropBefore && <div className={styles.subDropLine} />}

          <div
            className={`${styles.subtaskRow} ${depth > 0 ? styles.subtaskRowNested : ""} ${node.done ? styles.subtaskDone : ""} ${isDropChild ? styles.subDropChildTarget : ""}`}
            draggable
            onDragStart={e => handleSubDragStart(e, taskId, node.id)}
            onDragOver={e => handleSubDragOver(e, taskId, node.id)}
            onDrop={e => handleSubDrop(e, taskId)}
            onDragEnd={handleSubDragEnd}
          >
            <div className={styles.subDragHandle}>⠿</div>
            <button
              className={styles.subCollapseBtn}
              style={{ visibility: hasChildren ? "visible" : "hidden" }}
              onClick={() => setCollapsedNodes(prev => {
                const next = new Set(prev);
                next.has(node.id) ? next.delete(node.id) : next.add(node.id);
                return next;
              })}
            >{isNodeCollapsed ? "▶" : "▼"}</button>
            <button
              className={`${styles.subCheck} ${node.done ? styles.subChecked : ""}`}
              onClick={() => handleToggleSubtask(taskId, node.id)}
            >{node.done ? "✓" : ""}</button>
            <span
              className={`${styles.subtaskTitle} ${editingSubNodeId === node.id ? styles.subtaskTitleActive : ""}`}
              onClick={e => { e.stopPropagation(); editingSubNodeId === node.id ? setEditingSubNodeId(null) : openSubNodeEdit(taskId, node); }}
              title="Click to edit"
            >{node.title}</span>
            {hasChildren && isNodeCollapsed && (
              <span className={styles.subChildCount}>{childDoneCount}/{childCount}</span>
            )}
            <button
              className={`${styles.subNotesBtn} ${!notesLocked && node.notes ? styles.subNotesBtnHasNotes : ""} ${notesLocked ? styles.notesBtnLocked : ""}`}
              onClick={e => {
                e.stopPropagation();
                if (notesLocked) { openLockDialog(parentTask!.projectId, "unlock", taskId); return; }
                editingSubNodeId === node.id ? setEditingSubNodeId(null) : openSubNodeEdit(taskId, node);
              }}
              title={notesLocked ? "Notes locked — click to unlock" : node.notes ? "Edit notes" : "Add notes"}
            >{notesLocked ? "🔒" : "✏️"}</button>
            <button className={styles.subAddChildBtn}
              onClick={() => {
                setCollapsedNodes(prev => { const n = new Set(prev); n.delete(node.id); return n; });
                setAddingSubFor({ taskId, parentNodeId: node.id });
              }}
              title="Add child subtask">+</button>
            <button className={styles.deleteBtn}
              onClick={() => handleDeleteSubtask(taskId, node.id)}>×</button>
          </div>

          {/* Subtask node notes preview */}
          {node.notes && editingSubNodeId !== node.id && (
            notesLocked
              ? <div className={styles.notesLockedHint} onClick={() => openLockDialog(parentTask!.projectId, "unlock", taskId)}>🔒 Notes hidden — click to unlock</div>
              : <div className={styles.subNotesPreview}>{node.notes.split("\n")[0]}</div>
          )}

          {/* Combined title + notes edit panel */}
          {editingSubNodeId === node.id && (
            <div className={styles.subEditPanel}>
              <input
                className={styles.subtaskEditInput}
                value={editingSubNodeTitle}
                autoFocus
                placeholder="Subtask title…"
                onChange={e => setEditingSubNodeTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") setEditingSubNodeId(null); }}
                onClick={e => e.stopPropagation()}
              />
              {notesLocked ? (
                <div className={styles.notesLockedMsg}>
                  Notes are locked.{" "}
                  <button className={styles.linkBtn} onClick={e => { e.stopPropagation(); setEditingSubNodeId(null); openLockDialog(parentTask!.projectId, "unlock", taskId); }}>Unlock to edit</button>
                </div>
              ) : (
                <textarea
                  className={styles.subNotesTextarea}
                  value={subNodeNotesDraft}
                  rows={2}
                  placeholder="Add notes…"
                  onChange={e => setSubNodeNotesDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Escape") setEditingSubNodeId(null); }}
                  onClick={e => e.stopPropagation()}
                />
              )}
              <div className={styles.notesActions}>
                <button className={styles.subtaskAddBtn} onClick={e => { e.stopPropagation(); saveSubNodeEdit(taskId, node.id); }}>Save</button>
                <button className={styles.subtaskCancelBtn} onClick={e => { e.stopPropagation(); setEditingSubNodeId(null); }}>Cancel</button>
              </div>
            </div>
          )}

          {isDropAfter && <div className={styles.subDropLine} />}

          {!isNodeCollapsed && (
            <div className={styles.subtreeContainer}>
              {renderSubtree(children, taskId, depth + 1)}
              {addingSubFor?.taskId === taskId && addingSubFor.parentNodeId === node.id && (
                <div className={styles.subtaskAddRow}>
                  <input className={styles.subtaskInput} placeholder="Child subtask…"
                    value={newSubText} autoFocus
                    onChange={e => setNewSubText(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleAddSubtask(); if (e.key === "Escape") { setAddingSubFor(null); setNewSubText(""); } }} />
                  <button className={styles.subtaskAddBtn} onClick={handleAddSubtask}>Add</button>
                  <button className={styles.subtaskCancelBtn} onClick={() => { setAddingSubFor(null); setNewSubText(""); }}>Cancel</button>
                </div>
              )}
            </div>
          )}
        </Fragment>
      );
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <div className={styles.center}>Loading…</div>;
  if (!state)  return <div className={styles.center}><p>No data found.</p></div>;

  // Build parent → child task map (tasks with parentTaskId are nested under their parent)
  const childTaskMap = new Map<string, Task[]>();
  for (const t of state.tasks) {
    if (t.parentTaskId) {
      const arr = childTaskMap.get(t.parentTaskId) ?? [];
      arr.push(t);
      childTaskMap.set(t.parentTaskId, arr);
    }
  }

  // Private project helper — is a project notes-locked? (tasks always visible, only notes masked)
  const isProjectLocked = (projectId: string) => {
    const proj = state.projects.find(p => p.id === projectId);
    return !!(proj?.private && !unlockedProjects.has(projectId));
  };

  // Per-task notes lock: true if notes should be masked (project is private and neither project nor task is unlocked)
  const isTaskNotesLocked = (task: Task): boolean => {
    const proj = state.projects.find(p => p.id === task.projectId);
    if (!proj?.private) return false;
    const store = readUnlockStore();
    const now = Date.now();
    if (store[task.projectId] && store[task.projectId] > now) return false;
    if (store[`${task.projectId}:${task.id}`] && store[`${task.projectId}:${task.id}`] > now) return false;
    return true;
  };

  const etaWarningDays = state.settings?.etaWarningDays ?? 3;

  // Top-level = no parentTaskId, exclude archived (tasks in locked projects ARE shown — notes masked)
  const topLevelTasks = state.tasks.filter(t => !t.parentTaskId && !t.archived);
  const taskSearchLower = taskSearch.toLowerCase();
  const tasks = topLevelTasks
    .filter(t => filterDone ? t.done : !t.done)
    .filter(t => filterProject === "all" || t.projectId === filterProject)
    .filter(t => !taskSearch || t.title.toLowerCase().includes(taskSearchLower) || (!isTaskNotesLocked(t) && (t.notes ?? "").toLowerCase().includes(taskSearchLower)))
    .sort((a, b) => {
      // When viewing a single project: float ETA-imminent tasks to top
      if (filterProject === "all") return 0;
      const aIm = isEtaImminent(a, todayStr, etaWarningDays);
      const bIm = isEtaImminent(b, todayStr, etaWarningDays);
      if (aIm !== bIm) return aIm ? -1 : 1;
      if (aIm && bIm) {
        const da = daysUntilEta(a.eta, todayStr) ?? 999;
        const db = daysUntilEta(b.eta, todayStr) ?? 999;
        if (da !== db) return da - db;
      }
      return 0; // preserve original order otherwise
    });

  const activeTasks = state.tasks.filter(t => !t.done && !t.archived);

  // Archived tasks (for the recoverable trash view)
  const archivedTasks = state.tasks.filter(t => !!t.archived && !t.parentTaskId
    && (filterProject === "all" || t.projectId === filterProject));

  // ── Task card content (shared by top-level and child tasks) ──────────────────

  function renderTaskCardContent(task: Task) {
    const subtasks = task.subtasks ?? [];
    const totalCount = countNodes(subtasks);
    const doneCount  = countDoneNodes(subtasks);
    const isTaskCollapsed = collapsedTasks.has(task.id);
    const priorityClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
    const childTasks = childTaskMap.get(task.id) ?? [];
    const childCount = childTasks.length;

    return (
      <>
        <div className={styles.taskRow}>
          <div className={styles.dragHandle} title="Drag to reorder">⠿</div>
          <button
            className={`${styles.checkBtn} ${task.done ? styles.checked : ""}`}
            onClick={() => handleToggleDone(task.id)}
            title={task.done ? "Mark active" : "Mark done"}
          >{task.done ? "✓" : ""}</button>

          <div className={styles.taskBody}>
            <span
              className={`${styles.taskTitle} ${taskEditOpenFor === task.id ? styles.taskTitleActive : ""}`}
              onClick={e => { e.stopPropagation(); taskEditOpenFor === task.id ? setTaskEditOpenFor(null) : openTaskEdit(task); }}
              draggable={false}
              title="Click to edit"
            >{task.title}</span>
            <div className={styles.taskMeta}>
              <button className={`${styles.priority} ${priorityClass} ${styles.priorityBtn}`} title="Click to change priority" onClick={e => { e.stopPropagation(); handleUpdatePriority(task.id, task.priority); }}>{task.priority}</button>
              {projects.find(p => p.id === task.projectId) && (
                <span className={styles.project}>{projects.find(p => p.id === task.projectId)!.name}</span>
              )}
              {task.eta && (() => {
                const d = daysUntilEta(task.eta, todayStr);
                const ov = d !== null && d < 0;
                const im = d !== null && d <= etaWarningDays;
                return (
                  <span className={`${styles.eta} ${ov ? styles.etaOverdue : im ? styles.etaImminent : ""}`} title={ov ? `Overdue by ${Math.abs(d!)}d` : im ? `Due in ${d}d` : ""}>
                    {ov ? "⚠️ " : im ? "🔴 " : ""}due {task.eta}
                    {ov ? ` (${Math.abs(d!)}d overdue)` : im && d === 0 ? " (today!)" : im ? ` (${d}d left)` : ""}
                  </span>
                );
              })()}
              <span className={styles.date}>{task.createdAt}</span>
            </div>
          </div>

          <div className={styles.taskActions}>
            {(() => {
              const notesLocked = isTaskNotesLocked(task);
              return (
                <button
                  className={`${styles.notesBtn} ${!notesLocked && task.notes ? styles.notesBtnHasNotes : ""} ${!notesLocked && notesOpenFor === task.id ? styles.notesBtnOpen : ""} ${notesLocked ? styles.notesBtnLocked : ""}`}
                  onClick={() => {
                    if (notesLocked) { openLockDialog(task.projectId, "unlock", task.id); return; }
                    notesOpenFor === task.id ? setNotesOpenFor(null) : openNotes(task);
                  }}
                  title={notesLocked ? "Notes locked — click to unlock" : task.notes ? "Edit notes" : "Add notes"}
                >{notesLocked ? "🔒" : "✏️"}</button>
              );
            })()}
            <button
              className={`${styles.subtaskToggle} ${!isTaskCollapsed && (totalCount > 0 || childCount > 0) ? styles.subtaskToggleOpen : ""}`}
              onClick={() => setCollapsedTasks(prev => {
                const next = new Set(prev);
                next.has(task.id) ? next.delete(task.id) : next.add(task.id);
                return next;
              })}
              title={isTaskCollapsed ? "Show children" : "Collapse children"}
            >
              {totalCount > 0 ? `${doneCount}/${totalCount}` : childCount > 0 ? `${childCount}` : "sub"}
              <span className={styles.chevron}>{isTaskCollapsed ? "▼" : "▲"}</span>
            </button>
            <button className={styles.deleteBtn} onClick={() => handleDeleteTask(task.id)} title="Delete">×</button>
          </div>
        </div>

        {/* Inline notes preview — hidden when edit panel is open */}
        {task.notes && notesOpenFor !== task.id && taskEditOpenFor !== task.id && (() => {
          const notesLocked = isTaskNotesLocked(task);
          if (notesLocked) {
            return (
              <div
                className={styles.notesLockedHint}
                onClick={() => openLockDialog(task.projectId, "unlock", task.id)}
                title="Click to unlock notes"
              >🔒 Notes hidden — click to unlock</div>
            );
          }
          return (
            <div
              className={`${styles.notesPreview} ${notesExpandedFor.has(task.id) ? styles.notesPreviewExpanded : ""}`}
              onClick={e => { e.stopPropagation(); setNotesExpandedFor(prev => { const n = new Set(prev); n.has(task.id) ? n.delete(task.id) : n.add(task.id); return n; }); }}
              title="Click to expand · Click title to edit"
            >
              {notesExpandedFor.has(task.id) ? task.notes : task.notes.split("\n")[0]}
            </div>
          );
        })()}

        {/* Subtask nodes — visible by default */}
        {!isTaskCollapsed && (
          <div className={styles.subtaskSection}
            onDrop={e => { if (subDragNodeId.current) handleSubDrop(e, task.id); }}
            onDragOver={e => { if (subDragNodeId.current) e.preventDefault(); }}>
            {renderSubtree(subtasks, task.id, 0)}
            {addingSubFor?.taskId === task.id && addingSubFor.parentNodeId === null ? (
              <div className={styles.subtaskAddRow}>
                <input className={styles.subtaskInput} placeholder="New subtask…"
                  value={newSubText} autoFocus
                  onChange={e => setNewSubText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleAddSubtask(); if (e.key === "Escape") { setAddingSubFor(null); setNewSubText(""); } }} />
                <button className={styles.subtaskAddBtn} onClick={handleAddSubtask}>Add</button>
                <button className={styles.subtaskCancelBtn} onClick={() => { setAddingSubFor(null); setNewSubText(""); }}>Cancel</button>
              </div>
            ) : (
              <button className={styles.subtaskNewBtn}
                onClick={() => setAddingSubFor({ taskId: task.id, parentNodeId: null })}>
                + Add subtask
              </button>
            )}
          </div>
        )}

        {/* Completion form — shown when checking off a task */}
        {completingTaskId === task.id && (
          <div className={styles.completionPanel}>
            <div className={styles.completionHeader}>✓ Mark as done</div>
            <input
              className={styles.subtaskInput}
              placeholder="Optional: link, PR, doc URL, or brief outcome…"
              value={completionOutput}
              autoFocus
              onChange={e => setCompletionOutput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") confirmComplete(task.id);
                if (e.key === "Escape") { setCompletingTaskId(null); setCompletionOutput(""); }
              }}
            />
            <div className={styles.notesActions}>
              <button className={styles.subtaskAddBtn} onClick={() => confirmComplete(task.id)}>Done</button>
              <button className={styles.subtaskCancelBtn} onClick={() => confirmComplete(task.id, true)}>Skip</button>
              <button className={styles.subtaskCancelBtn} onClick={() => { setCompletingTaskId(null); setCompletionOutput(""); }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Output pill — shown on done tasks that have output */}
        {task.done && task.output && (
          <div className={styles.outputLine}>
            <span className={styles.outputLabel}>Output</span>
            <span className={styles.outputText}>{task.output}</span>
          </div>
        )}

        {/* Combined title + notes edit panel */}
        {taskEditOpenFor === task.id && (() => {
          const notesLocked = isTaskNotesLocked(task);
          return (
            <div className={styles.taskEditPanel}>
              <div className={styles.taskEditField}>
                <label className={styles.taskEditLabel}>Title</label>
                <input
                  className={styles.taskEditInput}
                  value={taskEditTitle}
                  autoFocus
                  onChange={e => setTaskEditTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) saveTaskEdit(task.id); if (e.key === "Escape") setTaskEditOpenFor(null); }}
                  onClick={e => e.stopPropagation()}
                />
              </div>
              <div className={styles.taskEditField}>
                <label className={styles.taskEditLabel}>Notes{notesLocked ? " 🔒" : ""}</label>
                {notesLocked ? (
                  <div className={styles.notesLockedMsg}>
                    Notes are locked.{" "}
                    <button className={styles.linkBtn} onClick={e => { e.stopPropagation(); setTaskEditOpenFor(null); openLockDialog(task.projectId, "unlock", task.id); }}>Unlock to edit</button>
                  </div>
                ) : (
                  <textarea
                    className={styles.taskEditTextarea}
                    value={taskEditNotes}
                    rows={4}
                    placeholder="Add notes, links, context…"
                    onChange={e => setTaskEditNotes(e.target.value)}
                    onKeyDown={e => { if (e.key === "Escape") setTaskEditOpenFor(null); }}
                    onClick={e => e.stopPropagation()}
                  />
                )}
              </div>
              <div className={styles.taskEditField}>
                <label className={styles.taskEditLabel}>Need by date</label>
                <input
                  type="date"
                  className={styles.taskEditInput}
                  value={taskEditEta}
                  onChange={e => setTaskEditEta(e.target.value)}
                  onClick={e => e.stopPropagation()}
                />
              </div>
              <div className={styles.taskEditField}>
                <label className={styles.taskEditLabel}>Project</label>
                <select
                  className={styles.select}
                  value={taskEditProject}
                  onChange={e => setTaskEditProject(e.target.value)}
                  onClick={e => e.stopPropagation()}
                >
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className={styles.taskEditActions}>
                <button className={styles.subtaskAddBtn} onClick={e => { e.stopPropagation(); saveTaskEdit(task.id); }}>Save</button>
                <button className={styles.subtaskCancelBtn} onClick={e => { e.stopPropagation(); setTaskEditOpenFor(null); }}>Cancel</button>
              </div>
            </div>
          );
        })()}

        {/* Notes panel (standalone, kept for ✏️ button) */}
        {notesOpenFor === task.id && taskEditOpenFor !== task.id && (
          <div className={styles.notesPanel}>
            <textarea className={styles.notesTextarea} placeholder="Write notes…"
              value={notesDraft} rows={3} autoFocus
              onChange={e => setNotesDraft(e.target.value)} />
            <div className={styles.notesActions}>
              <button className={styles.subtaskAddBtn} onClick={() => saveNotes(task.id)}>Save</button>
              <button className={styles.subtaskCancelBtn} onClick={() => setNotesOpenFor(null)}>Cancel</button>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── Render child tasks recursively (parentTaskId hierarchy) ──────────────────

  function renderChildTasks(parentId: string, depth: number): React.ReactNode {
    const children = childTaskMap.get(parentId);
    if (!children?.length) return null;
    const isCollapsed = collapsedTasks.has(parentId);
    if (isCollapsed) return null;
    return (
      <div className={styles.childTaskList} style={{ paddingLeft: depth * 16 }}>
        {children.map(child => (
          <div key={child.id} className={styles.childTaskWrapper}>
            <div className={`${styles.taskItem} ${child.priority === "High" ? styles.borderHigh : child.priority === "Medium" ? styles.borderMedium : styles.borderLow} ${child.done ? styles.taskDone : ""}`}>
              {renderTaskCardContent(child)}
            </div>
            {renderChildTasks(child.id, depth + 1)}
          </div>
        ))}
      </div>
    );
  }
  const topics = state.learningTopics ?? [];
  const projects = state.projects ?? [];
  const todayBoard = state.dailyBoards?.find(b => b.date === todayStr) ?? null;
  const boardTaskObjects = (todayBoard?.taskIds ?? [])
    .map(id => state.tasks.find(t => t.id === id))
    .filter((t): t is Task => !!t && !t.archived);
  // Build hierarchical setup task list: parents with their children nested
  const memoProject = projects.find(p => p.name === "Memo");
  // Resolve which project ID to use for the setup filter
  const setupProjectId = (() => {
    if (dailySetupProjectId === "memo") return memoProject?.id ?? null;
    if (dailySetupProjectId === "all") return null;
    return dailySetupProjectId;
  })();
  const allIncompleteTasks = state.tasks.filter(t => !t.done && !t.archived && (!setupProjectId || t.projectId === setupProjectId));
  const setupParents = allIncompleteTasks.filter(t => !t.parentTaskId);
  const setupChildMap = new Map<string, Task[]>();
  for (const t of allIncompleteTasks) {
    if (t.parentTaskId) {
      const arr = setupChildMap.get(t.parentTaskId) ?? [];
      arr.push(t); setupChildMap.set(t.parentTaskId, arr);
    }
  }
  const prio = { High: 3, Medium: 2, Low: 1 } as Record<string, number>;
  const isSetupSuggested = (t: Task) => t.priority === "High" || (t.dailyRank ?? 0) > 0 || isEtaImminent(t, todayStr, etaWarningDays);
  const setupSearchLower = dailySetupSearch.toLowerCase();
  const matchesSetupSearch = (t: Task) =>
    !dailySetupSearch || t.title.toLowerCase().includes(setupSearchLower) || (t.notes ?? "").toLowerCase().includes(setupSearchLower);
  const filteredParents = (dailySetupFilter === "suggested"
    ? setupParents.filter(t => isSetupSuggested(t) || (setupChildMap.get(t.id) ?? []).some(isSetupSuggested))
    : setupParents
  ).filter(t => matchesSetupSearch(t) || (setupChildMap.get(t.id) ?? []).some(matchesSetupSearch))
  .sort((a, b) => {
    const rd = (b.dailyRank ?? 0) - (a.dailyRank ?? 0);
    if (rd !== 0) return rd;
    return (prio[b.priority] ?? 0) - (prio[a.priority] ?? 0);
  });
  // Flat selectAll targets (all visible tasks including children)
  const setupTasks = filteredParents; // kept for select-all of parents
  const allSetupVisible = filteredParents.flatMap(p => [p, ...(setupChildMap.get(p.id) ?? []).filter(c => dailySetupFilter === "all" || isSetupSuggested(c))]);

  // ── Project board computed values ─────────────────────────────────────────────
  const projectBoards = state.projectBoards ?? [];
  const pbActiveBoards = projectBoards.filter(b => !b.wrapped);
  const pbWrappedBoards = projectBoards.filter(b => b.wrapped);
  const selectedBoard = pbSelectedId ? projectBoards.find(b => b.id === pbSelectedId) ?? null : null;
  const pbSetupProjectTasks = state.tasks.filter(t => !t.done && t.projectId === pbSetupProjectId);
  const pbSearchLower = pbSetupSearch.toLowerCase();
  const pbSetupFilteredTasks = pbSetupProjectTasks
    .filter(t => !pbSetupSearch || t.title.toLowerCase().includes(pbSearchLower))
    .sort((a, b) => (BOARD_PRIO[b.priority] ?? 0) - (BOARD_PRIO[a.priority] ?? 0));

  return (
    <div className={styles.app} data-theme={theme}>
      {/* Floating theme picker */}
      <div className={styles.themePicker}>
        <button className={styles.themePickerBtn} onClick={() => setThemePickerOpen(o => !o)} title="Choose theme">🎨</button>
        {themePickerOpen && (
          <div className={styles.themePickerPanel}>
            {THEMES.map(t => (
              <button key={t.id} className={`${styles.themeOption} ${theme === t.id ? styles.themeOptionActive : ""}`} onClick={() => { setTheme(t.id); setThemePickerOpen(false); }}>
                <span className={styles.themeSwatch} style={{ background: t.swatch }} />{t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Mobile top bar — only shown on small screens */}
      {isMobile && (
        <div className={styles.mobileTopBar}>
          <span className={styles.mobileTopBarLogo}>Hub</span>
          {saving && <span className={styles.mobileTopBarSaving}>Saving…</span>}
        </div>
      )}

      <div className={isMobile ? styles.mobileLayout : styles.appLayout}>
        {/* Desktop sidebar */}
        {!isMobile && (
          <aside className={styles.sidebar}>
            <div className={styles.sidebarLogo}>Hub</div>
            <nav className={styles.sidebarNav}>
              <button className={`${styles.sidebarTab} ${tab === "tasks" ? styles.sidebarTabActive : ""}`} onClick={() => setTab("tasks")}>
                📋 Tasks <span className={styles.sidebarBadge}>{activeTasks.length}</span>
              </button>
              <button className={`${styles.sidebarTab} ${tab === "today" ? styles.sidebarTabActive : ""}`} onClick={switchToToday}>
                ⚡ Today {todayBoard && <span className={styles.sidebarBadge}>{boardTaskObjects.filter(t => !t.done).length}</span>}
              </button>
              <button className={`${styles.sidebarTab} ${tab === "boards" ? styles.sidebarTabActive : ""}`} onClick={() => { setTab("boards"); setPbView("list"); }}>
                📁 Boards {pbActiveBoards.length > 0 && <span className={styles.sidebarBadge}>{pbActiveBoards.length}</span>}
              </button>
              <button className={`${styles.sidebarTab} ${tab === "topics" ? styles.sidebarTabActive : ""}`} onClick={() => setTab("topics")}>
                📚 Topics <span className={styles.sidebarBadge}>{topics.filter(t => t.trackWeekly).length}</span>
              </button>
              <button className={`${styles.sidebarTab} ${tab === "settings" ? styles.sidebarTabActive : ""}`} onClick={() => setTab("settings")}>
                ⚙️ Settings
              </button>
            </nav>
            <div className={styles.sidebarDivider} />
            <div className={styles.sidebarSection}>Projects</div>
            <div className={styles.sidebarProjects}>
              <button className={`${styles.sidebarProject} ${filterProject === "all" ? styles.sidebarProjectActive : ""}`}
                onClick={() => { setFilterProject("all"); if (tab !== "tasks") setTab("tasks"); }}>
                <span className={styles.sidebarProjectDot} style={{ background: "#a78bfa" }} />
                <span className={styles.sidebarProjectName}>All Tasks</span>
                <span className={styles.sidebarProjectCount}>{activeTasks.length}</span>
              </button>
              {projects.map((p, i) => {
                const locked = isProjectLocked(p.id);
                const boardCount = pbActiveBoards.filter(b => b.projectId === p.id).length;
                return (
                <div key={p.id} className={styles.sidebarProjectRow}>
                  <button
                    className={`${styles.sidebarProject} ${filterProject === p.id && tab === "tasks" ? styles.sidebarProjectActive : ""}`}
                    onClick={() => { setFilterProject(p.id); if (tab !== "tasks") setTab("tasks"); }}>
                    <span className={styles.sidebarProjectDot} style={{ background: PROJECT_COLORS[i % PROJECT_COLORS.length] }} />
                    <span className={styles.sidebarProjectName}>{locked ? "🔒 " : ""}{p.name}</span>
                    <span className={styles.sidebarProjectCount}>{state.tasks.filter(t => !t.done && t.projectId === p.id).length}</span>
                  </button>
                  <button
                    className={`${styles.sidebarBoardsBtn} ${tab === "boards" && pbFilterProjectId === p.id ? styles.sidebarBoardsBtnActive : ""}`}
                    onClick={e => { e.stopPropagation(); goToProjectBoards(p.id); }}
                    title={`${boardCount} active board${boardCount !== 1 ? "s" : ""} — open boards`}
                  >📁{boardCount > 0 && <span className={styles.sidebarBoardsBadge}>{boardCount}</span>}</button>
                </div>
                );
              })}

            </div>
            {saving && <div className={styles.sidebarSaving}>Saving…</div>}
          </aside>
        )}

        {/* Main content */}
        <div className={isMobile ? styles.mobileMain : styles.mainArea}>
          <main className={styles.main}>

        {/* ── Tasks ── */}
        {tab === "tasks" && (
          <>
            <form className={styles.addForm} onSubmit={handleAddTask}>
              <input className={styles.addFormInput} placeholder="Add a task…" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} />
              <div className={styles.addFormControls}>
                <select className={styles.select} value={newTaskPriority} onChange={e => setNewTaskPriority(e.target.value as "High" | "Medium" | "Low")}>
                  <option>High</option><option>Medium</option><option>Low</option>
                </select>
                {projects.length > 0 && (
                  <select className={styles.select} value={newTaskProject} onChange={e => setNewTaskProject(e.target.value)}>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
                <button type="button" className={`${styles.addNotesToggle} ${newTaskNotesOpen ? styles.addNotesToggleActive : ""}`}
                  onClick={() => setNewTaskNotesOpen(o => !o)} title="Add notes">
                  📝
                </button>
                <button className={styles.btn} type="submit">Add</button>
                <button type="button" className={styles.btnOutline} onClick={() => { setImportOpen(o => !o); if (!importProject) setImportProject(newTaskProject); }}>Import</button>
              </div>
              <div className={styles.addTaskExtra}>
                {newTaskNotesOpen && (
                  <textarea
                    className={styles.addNotesField}
                    placeholder="Notes (optional)…"
                    value={newTaskNotes}
                    rows={2}
                    onChange={e => setNewTaskNotes(e.target.value)}
                  />
                )}
                <div className={styles.addEtaRow}>
                  <label className={styles.addEtaLabel}>Need by</label>
                  <input
                    type="date"
                    className={styles.addEtaInput}
                    value={newTaskEta}
                    onChange={e => setNewTaskEta(e.target.value)}
                    title="Need by date (optional)"
                  />
                  {newTaskEta && <button type="button" className={styles.addEtaClear} onClick={() => setNewTaskEta("")}>×</button>}
                </div>
              </div>
            </form>

            {importOpen && (
              <form className={styles.importPanel} onSubmit={handleImport}>
                <div className={styles.importHeader}>
                  <span className={styles.importTitle}>Import tasks</span>
                  <span className={styles.importHint}>One task per line — leading -, *, • stripped</span>
                </div>
                <textarea
                  className={styles.importTextarea}
                  placeholder={"Fix login bug\nWrite unit tests\nUpdate docs"}
                  value={importText}
                  rows={5}
                  autoFocus
                  onChange={e => setImportText(e.target.value)}
                />
                <div className={styles.importControls}>
                  <select className={styles.select} value={importPriority} onChange={e => setImportPriority(e.target.value as "High" | "Medium" | "Low")}>
                    <option>High</option><option>Medium</option><option>Low</option>
                  </select>
                  {projects.length > 0 && (
                    <select className={styles.select} value={importProject} onChange={e => setImportProject(e.target.value)}>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  <button className={styles.btn} type="submit" disabled={!importText.trim()}>
                    Import {importText.trim() ? `· ${importText.split("\n").filter(l => l.trim()).length} tasks` : ""}
                  </button>
                  <button type="button" className={styles.subtaskCancelBtn} onClick={() => { setImportOpen(false); setImportText(""); }}>Cancel</button>
                </div>
              </form>
            )}

            <div className={styles.filters}>
              <div className={styles.projectPills}>
                <button className={`${styles.pill} ${filterProject === "all" ? styles.pillActive : ""}`} onClick={() => setFilterProject("all")}>All</button>
                {projects.map(p => {
                  const locked = isProjectLocked(p.id);
                  return (
                    <button key={p.id}
                      className={`${styles.pill} ${filterProject === p.id ? styles.pillActive : ""} ${locked ? styles.pillLocked : ""}`}
                      onClick={() => setFilterProject(p.id)}>
                      {locked ? "🔒 " : ""}{p.name}
                    </button>
                  );
                })}
              </div>
              <label className={styles.filterToggle}>
                <input type="checkbox" checked={filterDone} onChange={e => { setFilterDone(e.target.checked); if (e.target.checked) setFilterArchived(false); }} /> Completed
              </label>
              <label className={styles.filterToggle}>
                <input type="checkbox" checked={filterArchived} onChange={e => { setFilterArchived(e.target.checked); if (e.target.checked) setFilterDone(false); }} /> Archived
              </label>
            </div>
            <div className={styles.searchBar}>
              <span className={styles.searchIcon}>🔍</span>
              <input
                className={styles.searchInput}
                placeholder="Search tasks…"
                value={taskSearch}
                onChange={e => setTaskSearch(e.target.value)}
              />
              {taskSearch && <button className={styles.searchClear} onClick={() => setTaskSearch("")}>✕</button>}
            </div>

            {/* Project boards shortcut — shown when a specific project is selected */}
            {filterProject !== "all" && (() => {
              const projBoards = pbActiveBoards.filter(b => b.projectId === filterProject);
              return (
                <div className={styles.projectBoardsShortcut}>
                  <span className={styles.projectBoardsShortcutLabel}>
                    📁 {projBoards.length > 0 ? `${projBoards.length} active board${projBoards.length !== 1 ? "s" : ""}` : "No active boards"}
                  </span>
                  <button className={styles.btnSmall} onClick={() => goToProjectBoards(filterProject)}>View boards</button>
                  <button className={styles.btnSmall} onClick={() => { openPbSetup(filterProject); setTab("boards"); }}>+ New board</button>
                </div>
              );
            })()}

            {/* Unlock-all-notes banner for locked projects */}
            {filterProject !== "all" && isProjectLocked(filterProject) && (
              <div className={styles.notesLockedBanner}>
                <span>🔒 Notes in this project are hidden.</span>
                <button className={styles.btnSmall} onClick={() => openLockDialog(filterProject, "unlock")}>
                  Show all notes
                </button>
              </div>
            )}

            {filterArchived ? (
              /* ── Archived tasks view ── */
              archivedTasks.length === 0 ? (
                <p className={styles.empty}>No archived tasks.</p>
              ) : (
                <ul className={styles.taskList}>
                  {archivedTasks.map(task => {
                    const proj = state.projects.find(p => p.id === task.projectId);
                    return (
                      <li key={task.id} className={styles.taskLi}>
                        <div className={styles.archivedItem}>
                          <div className={styles.archivedItemLeft}>
                            <div className={styles.archivedItemTitle}>{task.title}</div>
                            <div className={styles.archivedItemMeta}>
                              {proj && <span className={styles.archivedItemProject}>{proj.name}</span>}
                              <span className={`${styles.archivedItemPrio} ${task.priority === "High" ? styles.archivedPrioHigh : task.priority === "Medium" ? styles.archivedPrioMedium : styles.archivedPrioLow}`}>{task.priority}</span>
                              {task.createdAt && <span className={styles.archivedItemDate}>{task.createdAt}</span>}
                            </div>
                            {task.notes && <div className={styles.archivedItemNotes}>{task.notes.split("\n")[0]}</div>}
                          </div>
                          <div className={styles.archivedItemActions}>
                            <button className={styles.btnSmall} onClick={() => handleRestoreTask(task.id)}>↩ Restore</button>
                            <button className={styles.deleteBtnSm} onClick={() => handlePermanentDeleteTask(task.id)} title="Delete permanently">🗑</button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : tasks.length === 0 ? (
              <p className={styles.empty}>{filterDone ? "No completed tasks." : "All clear!"}</p>
            ) : (
              <ul className={styles.taskList} onDragEnd={handleDragEnd}>
                {tasks.map(task => {
                  const isDragging = dragId === task.id;

                  return (
                    <li key={task.id} className={styles.taskLi}>
                      {dragOverId === task.id && dragOverPos === "before" && <div className={styles.dropLine} />}

                      <div
                        className={`${styles.taskItem} ${task.priority === "High" ? styles.borderHigh : task.priority === "Medium" ? styles.borderMedium : styles.borderLow} ${task.done ? styles.taskDone : ""} ${isDragging ? styles.dragging : ""} ${taskEditOpenFor === task.id ? styles.taskItemEditing : ""}`}
                        draggable={taskEditOpenFor !== task.id}
                        onDragStart={e => handleDragStart(e, task.id)}
                        onDragOver={e => handleDragOver(e, task.id)}
                        onDrop={e => handleDrop(e, task.id)}
                      >
                        {renderTaskCardContent(task)}
                      </div>

                      {/* Child tasks (parentTaskId hierarchy) — nested below parent */}
                      {renderChildTasks(task.id, 1)}

                      {dragOverId === task.id && dragOverPos === "after" && <div className={styles.dropLine} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {/* ── Today ── */}
        {tab === "today" && (
          <>
            {(!todayBoard || dailyAddingMore || dailyShowSetup) ? (
              <div className={styles.dailySetup}>
                <div className={styles.dailySetupHeader}>
                  <div>
                    <h2 className={styles.dailySetupTitle}>{todayBoard ? "Add Tasks to Today" : "Start Today's Board"}</h2>
                    <p className={styles.dailySetupDate}>{todayStr}</p>
                  </div>
                  {(dailyAddingMore || dailyShowSetup) && <button className={styles.subtaskCancelBtn} onClick={() => { setDailyAddingMore(false); setDailyShowSetup(false); }}>Cancel</button>}
                </div>
                <div className={styles.dailyProjectPills}>
                  <button className={`${styles.pill} ${dailySetupProjectId === "memo" ? styles.pillActive : ""}`} onClick={() => setDailySetupProjectId("memo")}>Memo</button>
                  {projects.filter(p => p.name !== "Memo").map(p => (
                    <button key={p.id} className={`${styles.pill} ${dailySetupProjectId === p.id ? styles.pillActive : ""}`} onClick={() => setDailySetupProjectId(p.id)}>{p.name}</button>
                  ))}
                  <button className={`${styles.pill} ${dailySetupProjectId === "all" ? styles.pillActive : ""}`} onClick={() => setDailySetupProjectId("all")}>All</button>
                </div>
                <div className={styles.dailyFilterRow}>
                  <button className={`${styles.dailyFilterBtn} ${dailySetupFilter === "suggested" ? styles.dailyFilterBtnActive : ""}`} onClick={() => setDailySetupFilter("suggested")}>⭐ Suggested</button>
                  <button className={`${styles.dailyFilterBtn} ${dailySetupFilter === "all" ? styles.dailyFilterBtnActive : ""}`} onClick={() => setDailySetupFilter("all")}>All tasks</button>
                  <div className={styles.dailyBulkActions}>
                    <button className={styles.linkBtn} onClick={() => setDailySetupSelected(new Set(allSetupVisible.map(t => t.id)))}>Select all</button>
                    <span className={styles.dailySep}>·</span>
                    <button className={styles.linkBtn} onClick={() => setDailySetupSelected(new Set())}>Deselect all</button>
                    <span className={styles.dailySelectedCount}>{dailySetupSelected.size} selected</span>
                  </div>
                </div>
                <div className={styles.searchBar}>
                  <span className={styles.searchIcon}>🔍</span>
                  <input
                    className={styles.searchInput}
                    placeholder="Search tasks…"
                    value={dailySetupSearch}
                    onChange={e => setDailySetupSearch(e.target.value)}
                    autoFocus={!dailyAddingMore}
                  />
                  {dailySetupSearch && <button className={styles.searchClear} onClick={() => setDailySetupSearch("")}>✕</button>}
                </div>
                <div className={styles.dailySetupList}>
                  {filteredParents.map(task => {
                    const isSel = dailySetupSelected.has(task.id);
                    const pClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                    const proj = projects.find(p => p.id === task.projectId);
                    const children = (setupChildMap.get(task.id) ?? []).filter(c => dailySetupFilter === "all" || isSetupSuggested(c));
                    return (
                      <Fragment key={task.id}>
                        <div className={`${styles.dailySetupRow} ${isSel ? styles.dailySetupRowSelected : ""}`}
                          onClick={() => toggleDailySetupTask(task.id)}>
                          <div className={`${styles.dailySetupCheck} ${isSel ? styles.dailySetupCheckSelected : ""}`}>{isSel ? "✓" : ""}</div>
                          <span className={`${styles.priority} ${pClass}`}>{task.priority}</span>
                          <div className={styles.dailySetupTaskInfo}>
                            <span className={styles.dailySetupTaskTitle}>{task.title}</span>
                            {proj && <span className={styles.dailySetupTaskProj}>{proj.name}</span>}
                          </div>
                          {(task.dailyRank ?? 0) > 0 && <span className={styles.boostBadge}>↑{task.dailyRank}</span>}
                        </div>
                        {children.map(child => {
                          const cSel = dailySetupSelected.has(child.id);
                          const cClass = child.priority === "High" ? styles.priorityHigh : child.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                          return (
                            <div key={child.id} className={`${styles.dailySetupRow} ${styles.dailySetupChildRow} ${cSel ? styles.dailySetupRowSelected : ""}`}
                              onClick={() => toggleDailySetupTask(child.id, child.parentTaskId)}>
                              <div className={`${styles.dailySetupCheck} ${cSel ? styles.dailySetupCheckSelected : ""}`}>{cSel ? "✓" : ""}</div>
                              <span className={`${styles.priority} ${cClass}`}>{child.priority}</span>
                              <div className={styles.dailySetupTaskInfo}>
                                <span className={styles.dailySetupTaskTitle}>{child.title}</span>
                              </div>
                              {(child.dailyRank ?? 0) > 0 && <span className={styles.boostBadge}>↑{child.dailyRank}</span>}
                            </div>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  {filteredParents.length === 0 && <p className={styles.empty}>No tasks match this filter.</p>}

                  {/* New task form */}
                  {dailyShowNewForm ? (
                    <form className={styles.dailyNewTaskForm} onSubmit={handleDailyNewTask}>
                      <div className={styles.dailyNewTaskRow}>
                        <input className={styles.input} placeholder="New task title…" value={dailyNewTitle} autoFocus
                          onChange={e => setDailyNewTitle(e.target.value)}
                          onKeyDown={e => e.key === "Escape" && setDailyShowNewForm(false)} />
                        <select className={styles.select} value={dailyNewPriority} onChange={e => setDailyNewPriority(e.target.value as "High" | "Medium" | "Low")}>
                          <option>High</option><option>Medium</option><option>Low</option>
                        </select>
                        <button className={styles.btn} type="submit">Add</button>
                        <button type="button" className={styles.subtaskCancelBtn} onClick={() => { setDailyShowNewForm(false); setDailyNewNotes(""); }}>Cancel</button>
                      </div>
                      <textarea
                        className={styles.addNotesField}
                        placeholder="Notes (optional)…"
                        value={dailyNewNotes}
                        rows={2}
                        onChange={e => setDailyNewNotes(e.target.value)}
                      />
                    </form>
                  ) : (
                    <button className={styles.dailyNewTaskBtn} onClick={() => setDailyShowNewForm(true)}>+ Create new task</button>
                  )}
                </div>
                <div className={styles.dailySetupFooter}>
                  <button className={styles.btn} disabled={dailySetupSelected.size === 0} onClick={confirmDailySetup}>
                    {todayBoard ? `Add ${dailySetupSelected.size} tasks` : `Start Board · ${dailySetupSelected.size} tasks`}
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.dailyBoard}>
                <div className={styles.dailyBoardHeader}>
                  <div>
                    <h2 className={styles.dailyBoardTitle}>Today&apos;s Board</h2>
                    <span className={styles.dailyBoardMeta}>{todayStr} · {boardTaskObjects.filter(t => t.done).length}/{boardTaskObjects.length} done</span>
                  </div>
                  <div className={styles.dailyBoardHeaderActions}>
                    <button className={styles.btnOutline} onClick={startAddMore}>+ Add tasks</button>
                    {!todayBoard.wrapped && (
                      <button className={styles.dailyWrapBtn} onClick={openWrapUp}>Wrap Up Day</button>
                    )}
                    {todayBoard.wrapped && (
                      <button className={styles.btnOutline} onClick={() => {
                        // Un-wrap today's board — user wants to continue working on it
                        persist({ ...state, dailyBoards: (state.dailyBoards ?? []).map(b => b.date === todayStr ? { ...b, wrapped: false } : b) });
                      }}>↩ Re-open</button>
                    )}
                  </div>
                </div>
                {todayBoard.wrapped && <div className={styles.dailyWrapNote}>✅ Wrapped — incomplete tasks boosted. Add more tasks or re-open to keep working.</div>}

                {/* ── Wrap-up panel ── */}
                {wrapMode && (() => {
                  const board = state.dailyBoards?.find(b => b.date === todayStr)!;
                  const doneTasks = board.taskIds.map(id => state.tasks.find(t => t.id === id)!).filter(t => t?.done);
                  const incompleteTasks = board.taskIds.map(id => state.tasks.find(t => t.id === id)!).filter(t => t && !t.done);
                  return (
                    <div className={styles.wrapPanel}>
                      <div className={styles.wrapPanelHeader}>
                        <span className={styles.wrapPanelTitle}>Wrap Up Today</span>
                        <button className={styles.wrapCancelBtn} onClick={() => setWrapMode(false)}>✕</button>
                      </div>

                      {doneTasks.length > 0 && (
                        <div className={styles.wrapSection}>
                          <div className={styles.wrapSectionLabel}>
                            <span>✅ Completed — mark as resolved?</span>
                            <button className={styles.wrapSelectAll} onClick={() => setWrapResolveIds(new Set(doneTasks.map(t => t.id)))}>All</button>
                            <button className={styles.wrapSelectAll} onClick={() => setWrapResolveIds(new Set())}>None</button>
                          </div>
                          {doneTasks.map(task => (
                            <label key={task.id} className={styles.wrapRow}>
                              <input type="checkbox" checked={wrapResolveIds.has(task.id)} onChange={() => toggleWrapId(setWrapResolveIds, task.id)} />
                              <span className={styles.wrapRowTitle}>{task.title}</span>
                              <span className={`${styles.priority} ${task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow}`}>{task.priority}</span>
                            </label>
                          ))}
                        </div>
                      )}

                      {incompleteTasks.length > 0 && (
                        <div className={styles.wrapSection}>
                          <div className={styles.wrapSectionLabel}>
                            <span>📌 Incomplete — carry forward &amp; boost?</span>
                            <button className={styles.wrapSelectAll} onClick={() => setWrapCarryIds(new Set(incompleteTasks.map(t => t.id)))}>All</button>
                            <button className={styles.wrapSelectAll} onClick={() => setWrapCarryIds(new Set())}>None</button>
                          </div>
                          {incompleteTasks.map(task => (
                            <label key={task.id} className={styles.wrapRow}>
                              <input type="checkbox" checked={wrapCarryIds.has(task.id)} onChange={() => toggleWrapId(setWrapCarryIds, task.id)} />
                              <span className={styles.wrapRowTitle}>{task.title}</span>
                              <span className={`${styles.priority} ${task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow}`}>{task.priority}</span>
                            </label>
                          ))}
                        </div>
                      )}

                      <div className={styles.wrapPanelFooter}>
                        <button className={styles.btnOutline} onClick={() => setWrapMode(false)}>Cancel</button>
                        <button className={styles.dailyWrapBtn} onClick={confirmWrapUp}>Confirm Wrap Up</button>
                      </div>
                    </div>
                  );
                })()}
                <div className={styles.dailyBoardList} onDragEnd={handleDailyDragEnd}>
                  {boardTaskObjects.map((task, i) => {
                    const isDragging = dailyDragId === task.id;
                    const pClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                    const proj = projects.find(p => p.id === task.projectId);
                    const taskSubtasks = task.subtasks ?? [];
                    const totalSubCount = countNodes(taskSubtasks);
                    const doneSubCount = countDoneNodes(taskSubtasks);
                    const etaDays = daysUntilEta(task.eta, todayStr);
                    const etaImminent = etaDays !== null && etaDays <= etaWarningDays;
                    const etaOverdue = etaDays !== null && etaDays < 0;
                    return (
                      <Fragment key={task.id}>
                        {dailyDragOverId === task.id && dailyDragOverPos === "before" && <div className={styles.dailyDropLine} />}
                        <div className={`${styles.dailyBoardCard} ${dailyEditTaskId === task.id ? styles.dailyBoardCardEditing : ""} ${etaOverdue ? styles.dailyBoardCardOverdue : etaImminent ? styles.dailyBoardCardImminent : ""}`}>
                          <div
                            className={`${styles.dailyBoardItem} ${task.done ? styles.dailyBoardItemDone : ""} ${isDragging ? styles.dailyBoardItemDragging : ""}`}
                            draggable={!todayBoard.wrapped && dailyEditTaskId !== task.id}
                            onDragStart={e => handleDailyDragStart(e, task.id)}
                            onDragOver={e => handleDailyDragOver(e, task.id)}
                            onDrop={e => handleDailyDrop(e, task.id)}
                          >
                            <span className={styles.dailyRankNum}>{i + 1}</span>
                            <div className={styles.dailyDragHandle}>⠿</div>
                            <button className={`${styles.checkBtn} ${task.done ? styles.checked : ""}`} onClick={() => handleToggleDone(task.id)}>{task.done ? "✓" : ""}</button>
                            <div className={styles.dailyBoardTaskInfo}>
                              <span
                                className={`${styles.dailyBoardTaskTitle} ${dailyEditTaskId === task.id ? styles.taskTitleActive : ""}`}
                                onClick={e => { e.stopPropagation(); dailyEditTaskId === task.id ? setDailyEditTaskId(null) : openDailyTaskEdit(task); }}
                                draggable={false}
                                title="Click to edit"
                              >{task.title}</span>
                              <div className={styles.dailyBoardTaskMeta}>
                                <button className={`${styles.priority} ${pClass} ${styles.priorityBtn}`} title="Click to change priority" onClick={e => { e.stopPropagation(); handleUpdatePriority(task.id, task.priority); }}>{task.priority}</button>
                                {proj && <span className={styles.project}>{proj.name}</span>}
                                {task.parentTaskId && <span className={styles.parentBadge} title="Has parent task">↳ child</span>}
                                {task.eta && (
                                  <span
                                    className={`${styles.eta} ${etaOverdue ? styles.etaOverdue : etaImminent ? styles.etaImminent : ""}`}
                                    title={etaOverdue ? `Overdue by ${Math.abs(etaDays!)} day(s)` : etaImminent ? `Due in ${etaDays} day(s)` : `Due ${task.eta}`}
                                  >
                                    {etaOverdue ? "⚠️ " : etaImminent ? "🔴 " : ""}due {task.eta}
                                    {etaOverdue ? ` (${Math.abs(etaDays!)}d overdue)` : etaImminent && etaDays === 0 ? " (today!)" : etaImminent ? ` (${etaDays}d left)` : ""}
                                  </span>
                                )}
                                <button
                                  className={`${styles.dailySubCount} ${boardSubExpanded.has(task.id) ? styles.dailySubCountOpen : ""}`}
                                  onClick={e => { e.stopPropagation(); setBoardSubExpanded(prev => { const n = new Set(prev); n.has(task.id) ? n.delete(task.id) : n.add(task.id); return n; }); }}
                                  title={totalSubCount > 0 ? "Toggle subtasks" : "Add subtasks"}
                                >{totalSubCount > 0 ? `${doneSubCount}/${totalSubCount} sub` : "sub"} {boardSubExpanded.has(task.id) ? "▲" : "▼"}</button>
                              </div>
                              {task.notes && dailyEditTaskId !== task.id && (
                                <div className={styles.dailyTaskNotesPreview}>{task.notes.split("\n")[0]}</div>
                              )}
                              {task.done && task.output && (
                                <div className={styles.outputLine}>
                                  <span className={styles.outputLabel}>Output</span>
                                  <span className={styles.outputText}>{task.output}</span>
                                </div>
                              )}
                            </div>
                            {(task.dailyRank ?? 0) > 0 && <span className={styles.boostBadge} title={`Boosted ${task.dailyRank}×`}>↑{task.dailyRank}</span>}
                            <div className={styles.dailyItemActions}>
                              <button
                                className={`${styles.dailyEditBtn} ${dailyEditTaskId === task.id ? styles.dailyEditBtnActive : ""}`}
                                onClick={e => { e.stopPropagation(); dailyEditTaskId === task.id ? setDailyEditTaskId(null) : openDailyTaskEdit(task); }}
                                title="Edit notes & parent"
                              >✎</button>
                              {!todayBoard.wrapped && (task.dailyRank ?? 0) > 0 && <button className={styles.deboostBtn} onClick={() => deboostTask(task.id)} title="Remove boost">↓</button>}
                              {!todayBoard.wrapped && <button className={styles.deleteBtn} onClick={() => removeDailyTask(task.id)} title="Remove from today">×</button>}
                            </div>
                          </div>
                          {/* Inline subtask nodes on board — expanded when toggled */}
                          {boardSubExpanded.has(task.id) && (
                            <div className={styles.boardSubList}
                              onDrop={e => { if (subDragNodeId.current) handleSubDrop(e, task.id); }}
                              onDragOver={e => { if (subDragNodeId.current) e.preventDefault(); }}>
                              {renderSubtree(taskSubtasks, task.id, 0)}
                              {addingSubFor?.taskId === task.id && addingSubFor.parentNodeId === null ? (
                                <div className={styles.subtaskAddRow}>
                                  <input className={styles.subtaskInput} placeholder="New subtask…"
                                    value={newSubText} autoFocus
                                    onChange={e => setNewSubText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") handleAddSubtask(); if (e.key === "Escape") { setAddingSubFor(null); setNewSubText(""); } }} />
                                  <button className={styles.subtaskAddBtn} onClick={handleAddSubtask}>Add</button>
                                  <button className={styles.subtaskCancelBtn} onClick={() => { setAddingSubFor(null); setNewSubText(""); }}>Cancel</button>
                                </div>
                              ) : (
                                <button className={styles.subtaskNewBtn}
                                  onClick={() => setAddingSubFor({ taskId: task.id, parentNodeId: null })}>
                                  + Add subtask
                                </button>
                              )}
                            </div>
                          )}

                          {dailyEditTaskId === task.id && (
                            <div className={styles.dailyEditPanel}>
                              <div className={styles.dailyEditSection}>
                                <label className={styles.dailyEditLabel}>Title</label>
                                <input
                                  className={styles.taskEditInput}
                                  value={dailyEditTitle}
                                  autoFocus
                                  onChange={e => setDailyEditTitle(e.target.value)}
                                  onKeyDown={e => { if (e.key === "Enter") saveDailyTaskEdit(); if (e.key === "Escape") setDailyEditTaskId(null); }}
                                  onClick={e => e.stopPropagation()}
                                />
                              </div>
                              <div className={styles.dailyEditSection}>
                                <label className={styles.dailyEditLabel}>Notes</label>
                                <textarea
                                  className={styles.dailyEditTextarea}
                                  value={dailyEditNotes}
                                  onChange={e => setDailyEditNotes(e.target.value)}
                                  placeholder="Add notes, links, context…"
                                  rows={3}
                                />
                              </div>
                              <div className={styles.dailyEditSection}>
                                <label className={styles.dailyEditLabel}>Need by date</label>
                                <input
                                  type="date"
                                  className={styles.taskEditInput}
                                  value={dailyEditEta}
                                  onChange={e => setDailyEditEta(e.target.value)}
                                />
                              </div>
                              <div className={styles.dailyEditSection}>
                                <label className={styles.dailyEditLabel}>Parent task</label>
                                <select
                                  className={styles.select}
                                  value={dailyEditParentId ?? ""}
                                  onChange={e => setDailyEditParentId(e.target.value || null)}
                                >
                                  <option value="">— none (top-level) —</option>
                                  {state.tasks.filter(t => t.id !== task.id && !t.parentTaskId && !t.done).map(t => (
                                    <option key={t.id} value={t.id}>{t.title}</option>
                                  ))}
                                </select>
                              </div>
                              <div className={styles.dailyEditActions}>
                                <button className={styles.btn} onClick={saveDailyTaskEdit}>Save</button>
                                <button className={styles.subtaskCancelBtn} onClick={() => setDailyEditTaskId(null)}>Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>
                        {dailyDragOverId === task.id && dailyDragOverPos === "after" && <div className={styles.dailyDropLine} />}
                      </Fragment>
                    );
                  })}
                  {completingTaskId && boardTaskObjects.find(t => t.id === completingTaskId) && (
                    <div className={styles.completionPanel}>
                      <div className={styles.completionHeader}>✓ Mark as done</div>
                      <input className={styles.subtaskInput} placeholder="Optional: link, PR, doc URL, or brief outcome…"
                        value={completionOutput} autoFocus onChange={e => setCompletionOutput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") confirmComplete(completingTaskId); if (e.key === "Escape") { setCompletingTaskId(null); setCompletionOutput(""); } }} />
                      <div className={styles.notesActions}>
                        <button className={styles.subtaskAddBtn} onClick={() => confirmComplete(completingTaskId)}>Done</button>
                        <button className={styles.subtaskCancelBtn} onClick={() => confirmComplete(completingTaskId, true)}>Skip</button>
                        <button className={styles.subtaskCancelBtn} onClick={() => { setCompletingTaskId(null); setCompletionOutput(""); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Quick-add to board ── */}
                {!todayBoard.wrapped && (
                  boardQuickShow ? (
                    <form className={styles.boardQuickForm} onSubmit={handleBoardQuickAdd}>
                      <input
                        className={styles.input}
                        placeholder="New task title…"
                        value={boardQuickTitle}
                        autoFocus
                        onChange={e => setBoardQuickTitle(e.target.value)}
                        onKeyDown={e => e.key === "Escape" && (setBoardQuickShow(false), setBoardQuickTitle(""))}
                      />
                      <select className={styles.select} value={boardQuickPriority} onChange={e => setBoardQuickPriority(e.target.value as "High" | "Medium" | "Low")}>
                        <option>High</option><option>Medium</option><option>Low</option>
                      </select>
                      <button className={styles.btn} type="submit">Add to board</button>
                      <button type="button" className={styles.subtaskCancelBtn} onClick={() => { setBoardQuickShow(false); setBoardQuickTitle(""); }}>Cancel</button>
                    </form>
                  ) : (
                    <button className={styles.boardQuickBtn} onClick={() => setBoardQuickShow(true)}>+ Quick add task</button>
                  )
                )}
              </div>
            )}

            {/* ── Board History ── */}
            {(() => {
              const pastBoards = (state.dailyBoards ?? [])
                .filter(b => b.date !== todayStr)
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 30);
              if (!pastBoards.length) return null;
              return (
                <div className={styles.historySection}>
                  <button className={styles.historyToggle} onClick={() => setHistoryExpanded(h => !h)}>
                    <span>📅 Board History ({pastBoards.length} days)</span>
                    <span className={styles.chevron}>{historyExpanded ? "▲" : "▼"}</span>
                  </button>
                  {historyExpanded && (
                    <div className={styles.historyList}>
                      {pastBoards.map(board => {
                        const boardTasks = board.taskIds.map(id => state.tasks.find(t => t.id === id)).filter((t): t is Task => !!t);
                        const done = boardTasks.filter(t => t.done).length;
                        // Group: top-level tasks first, children indented under their parent
                        const topLevel = boardTasks.filter(t => !t.parentTaskId || !boardTasks.find(p => p.id === t.parentTaskId));
                        const childMap = new Map<string, Task[]>();
                        for (const t of boardTasks) {
                          if (t.parentTaskId && boardTasks.find(p => p.id === t.parentTaskId)) {
                            const arr = childMap.get(t.parentTaskId) ?? [];
                            arr.push(t);
                            childMap.set(t.parentTaskId, arr);
                          }
                        }
                        return (
                          <div key={board.date} className={styles.historyCard}>
                            <div className={styles.historyCardHeader}>
                              <span className={styles.historyDate}>{board.date}</span>
                              <span className={styles.historyStats}>{done}/{boardTasks.length} done{board.wrapped ? " · wrapped" : ""}</span>
                            </div>
                            <div className={styles.historyTaskList}>
                              {topLevel.map(t => {
                                const children = childMap.get(t.id) ?? [];
                                const subtaskNodes = t.subtasks ?? [];
                                const totalSubNodes = countNodes(subtaskNodes);
                                const doneSubNodes = countDoneNodes(subtaskNodes);
                                const pClass = t.priority === "High" ? styles.priorityHigh : t.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                                const hasDetail = !!(t.notes || t.output || children.length || totalSubNodes > 0);
                                const expandKey = `${board.date}-${t.id}`;
                                const isExpanded = historyTaskExpanded.has(expandKey);

                                // Flatten SubtaskNodes recursively for read-only history display
                                function flatSubNodes(nodes: SubtaskNode[], depth: number): React.ReactNode {
                                  return nodes.map(n => (
                                    <Fragment key={n.id}>
                                      <div className={`${styles.historySubNode} ${n.done ? styles.historyTaskDone : ""}`} style={{ paddingLeft: depth * 12 }}>
                                        <span className={styles.historyTaskDot}>{n.done ? "✓" : "○"}</span>
                                        <span className={styles.historyTaskTitle}>{n.title}</span>
                                      </div>
                                      {n.notes && <div className={styles.historySubNodeNotes} style={{ paddingLeft: depth * 12 + 20 }}>{n.notes.split("\n")[0]}</div>}
                                      {(n.children ?? []).length > 0 && flatSubNodes(n.children, depth + 1)}
                                    </Fragment>
                                  ));
                                }

                                return (
                                  <div key={t.id}>
                                    <div
                                      className={`${styles.historyTask} ${t.done ? styles.historyTaskDone : ""} ${hasDetail ? styles.historyTaskClickable : ""}`}
                                      onClick={() => hasDetail && setHistoryTaskExpanded(prev => {
                                        const n = new Set(prev); n.has(expandKey) ? n.delete(expandKey) : n.add(expandKey); return n;
                                      })}
                                    >
                                      <span className={styles.historyTaskDot}>{t.done ? "✓" : "○"}</span>
                                      <span className={styles.historyTaskTitle}>{t.title}</span>
                                      <span className={`${styles.priority} ${pClass}`}>{t.priority}</span>
                                      {totalSubNodes > 0 && <span className={styles.historyChildBadge}>{doneSubNodes}/{totalSubNodes} sub</span>}
                                      {children.length > 0 && <span className={styles.historyChildBadge}>{children.filter(c => c.done).length}/{children.length} child</span>}
                                      {hasDetail && <span className={styles.historyExpandChevron}>{isExpanded ? "▲" : "▼"}</span>}
                                    </div>
                                    {isExpanded && (
                                      <div className={styles.historyTaskDetail}>
                                        {t.notes && <div className={styles.historyTaskNotes}>{t.notes}</div>}
                                        {t.output && <div className={styles.historyTaskOutput}><span className={styles.outputLabel}>Output</span> {t.output}</div>}
                                        {totalSubNodes > 0 && (
                                          <div className={styles.historySubNodeList}>
                                            {flatSubNodes(subtaskNodes, 0)}
                                          </div>
                                        )}
                                        {children.map(child => (
                                          <div key={child.id} className={`${styles.historyChildTask} ${child.done ? styles.historyTaskDone : ""}`}>
                                            <span className={styles.historyTaskDot}>{child.done ? "✓" : "○"}</span>
                                            <span className={styles.historyTaskTitle}>{child.title}</span>
                                            <span className={`${styles.priority} ${child.priority === "High" ? styles.priorityHigh : child.priority === "Medium" ? styles.priorityMedium : styles.priorityLow}`}>{child.priority}</span>
                                            {child.output && <span className={styles.historyChildOutput}>{child.output}</span>}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {/* ── Project Boards ── */}
        {tab === "boards" && (
          <>
            {/* ── Setup view ── */}
            {pbView === "setup" && (
              <div className={styles.dailySetup}>
                <div className={styles.dailySetupHeader}>
                  <div>
                    <h2 className={styles.dailySetupTitle}>New Board</h2>
                    <p className={styles.dailySetupDate}>Pick tasks and give it a name</p>
                  </div>
                  <button className={styles.subtaskCancelBtn} onClick={() => setPbView("list")}>Cancel</button>
                </div>

                {/* Board name + date + project */}
                <div className={styles.pbSetupMeta}>
                  <input
                    className={styles.input}
                    placeholder="Board name…"
                    value={pbSetupName}
                    onChange={e => setPbSetupName(e.target.value)}
                  />
                  <input
                    className={styles.input}
                    type="date"
                    value={pbSetupDate}
                    onChange={e => setPbSetupDate(e.target.value)}
                  />
                  <select
                    className={styles.select}
                    value={pbSetupProjectId}
                    onChange={e => { setPbSetupProjectId(e.target.value); setPbSetupSelected(new Set()); }}
                  >
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>

                {/* Task selection */}
                <div className={styles.pbSetupBulk}>
                  <button className={styles.linkBtn} onClick={() => setPbSetupSelected(new Set(pbSetupFilteredTasks.map(t => t.id)))}>Select all</button>
                  <span className={styles.dailySep}>·</span>
                  <button className={styles.linkBtn} onClick={() => setPbSetupSelected(new Set())}>Deselect all</button>
                  <span className={styles.dailySelectedCount}>{pbSetupSelected.size} selected</span>
                </div>
                <div className={styles.searchBar}>
                  <span className={styles.searchIcon}>🔍</span>
                  <input
                    className={styles.searchInput}
                    placeholder="Search tasks…"
                    value={pbSetupSearch}
                    onChange={e => setPbSetupSearch(e.target.value)}
                  />
                  {pbSetupSearch && <button className={styles.searchClear} onClick={() => setPbSetupSearch("")}>✕</button>}
                </div>
                <div className={styles.dailySetupList}>
                  {pbSetupFilteredTasks.length === 0 ? (
                    <p className={styles.empty}>No open tasks in this project.</p>
                  ) : pbSetupFilteredTasks.map(task => {
                    const isSel = pbSetupSelected.has(task.id);
                    const pClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                    return (
                      <div key={task.id}
                        className={`${styles.dailySetupRow} ${isSel ? styles.dailySetupRowSelected : ""}`}
                        onClick={() => setPbSetupSelected(prev => { const n = new Set(prev); n.has(task.id) ? n.delete(task.id) : n.add(task.id); return n; })}>
                        <div className={`${styles.dailySetupCheck} ${isSel ? styles.dailySetupCheckSelected : ""}`}>{isSel ? "✓" : ""}</div>
                        <div className={styles.dailySetupRowBody}>
                          <span className={styles.dailySetupRowTitle}>{task.title}</span>
                          <span className={`${styles.priority} ${pClass}`}>{task.priority}</span>
                          {task.eta && <span className={styles.eta}>due {task.eta}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className={styles.dailySetupFooter}>
                  <button
                    className={styles.btn}
                    disabled={pbSetupSelected.size === 0 || !pbSetupName.trim()}
                    onClick={confirmPbSetup}
                  >
                    Create board · {pbSetupSelected.size} tasks
                  </button>
                </div>
              </div>
            )}

            {/* ── List view ── */}
            {pbView === "list" && (
              <div className={styles.pbListPage}>
                <div className={styles.pbListHeader}>
                  <h2 className={styles.pbListTitle}>Project Boards</h2>
                  <button className={styles.btn} onClick={() => openPbSetup(pbFilterProjectId !== "all" ? pbFilterProjectId : undefined)}>+ New Board</button>
                </div>

                {/* Project filter pills */}
                <div className={styles.projectPills}>
                  <button className={`${styles.pill} ${pbFilterProjectId === "all" ? styles.pillActive : ""}`} onClick={() => setPbFilterProjectId("all")}>All</button>
                  {projects.filter(p => projectBoards.some(b => b.projectId === p.id)).map(p => (
                    <button key={p.id}
                      className={`${styles.pill} ${pbFilterProjectId === p.id ? styles.pillActive : ""}`}
                      onClick={() => setPbFilterProjectId(p.id)}>{p.name}</button>
                  ))}
                </div>

                {pbActiveBoards.length === 0 && pbWrappedBoards.length === 0 ? (
                  <div className={styles.pbEmpty}>
                    <p>No project boards yet.</p>
                    <p>Create a board to group tasks from any project into a focused sprint.</p>
                    <button className={styles.btn} onClick={() => openPbSetup()}>+ Create your first board</button>
                  </div>
                ) : (
                  <>
                    {/* Active boards grouped by project */}
                    {projects.map(proj => {
                      const boards = pbActiveBoards.filter(b => b.projectId === proj.id);
                      if (boards.length === 0) return null;
                      if (pbFilterProjectId !== "all" && pbFilterProjectId !== proj.id) return null;
                      return (
                        <div key={proj.id} className={styles.pbProjectGroup}>
                          <div className={styles.pbProjectGroupHeader}>{proj.name}</div>
                          <div className={styles.pbBoardGrid}>
                            {boards.map(board => {
                              const boardTasks = board.taskIds.map(id => state.tasks.find(t => t.id === id)).filter(Boolean) as Task[];
                              const doneCount = boardTasks.filter(t => t.done).length;
                              return (
                                <div key={board.id} className={styles.pbBoardCard} onClick={() => openPbDetail(board.id)}>
                                  <div className={styles.pbBoardCardName}>{board.name}</div>
                                  <div className={styles.pbBoardCardMeta}>
                                    <span>{board.date}</span>
                                    <span>{doneCount}/{boardTasks.length} done</span>
                                  </div>
                                  <div className={styles.pbBoardCardBar}>
                                    <div className={styles.pbBoardCardBarFill} style={{ width: boardTasks.length ? `${(doneCount / boardTasks.length) * 100}%` : "0%" }} />
                                  </div>
                                </div>
                              );
                            })}
                            <div className={styles.pbBoardCardNew} onClick={() => openPbSetup(proj.id)}>+ New board</div>
                          </div>
                        </div>
                      );
                    })}

                    {/* Wrapped/archived boards */}
                    {pbWrappedBoards.filter(b => pbFilterProjectId === "all" || b.projectId === pbFilterProjectId).length > 0 && (
                      <div className={styles.pbProjectGroup}>
                        <button className={styles.pbShowWrappedBtn} onClick={() => setPbShowWrapped(o => !o)}>
                          {pbShowWrapped ? "▲" : "▼"} Wrapped boards ({pbWrappedBoards.filter(b => pbFilterProjectId === "all" || b.projectId === pbFilterProjectId).length})
                        </button>
                        {pbShowWrapped && (
                          <div className={styles.pbBoardGrid}>
                            {pbWrappedBoards.filter(b => pbFilterProjectId === "all" || b.projectId === pbFilterProjectId).map(board => {
                              const proj = projects.find(p => p.id === board.projectId);
                              const boardTasks = board.taskIds.map(id => state.tasks.find(t => t.id === id)).filter(Boolean) as Task[];
                              const doneCount = boardTasks.filter(t => t.done).length;
                              return (
                                <div key={board.id} className={`${styles.pbBoardCard} ${styles.pbBoardCardWrapped}`} onClick={() => openPbDetail(board.id)}>
                                  <div className={styles.pbBoardCardName}>{board.name}</div>
                                  <div className={styles.pbBoardCardMeta}>
                                    <span className={styles.pbBoardCardProject}>{proj?.name}</span>
                                    <span>{board.date}</span>
                                    <span>{doneCount}/{boardTasks.length} done</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Detail view ── */}
            {pbView === "detail" && selectedBoard && (() => {
              const boardTasks = selectedBoard.taskIds
                .map(id => state.tasks.find(t => t.id === id))
                .filter(Boolean) as Task[];
              const doneCount = boardTasks.filter(t => t.done).length;
              const proj = projects.find(p => p.id === selectedBoard.projectId);

              return (
                <div className={styles.pbDetailPage}>
                  {/* Header */}
                  <div className={styles.pbDetailHeader}>
                    <button className={styles.pbBackBtn} onClick={() => { setPbView("list"); setPbWrapMode(false); }}>← Boards</button>
                    <div className={styles.pbDetailTitleRow}>
                      {pbRenamingId === selectedBoard.id ? (
                        <input
                          className={styles.pbRenameInput}
                          autoFocus
                          value={pbRenameDraft}
                          onChange={e => setPbRenameDraft(e.target.value)}
                          onBlur={() => savePbRename(selectedBoard.id)}
                          onKeyDown={e => { if (e.key === "Enter") savePbRename(selectedBoard.id); if (e.key === "Escape") setPbRenamingId(null); }}
                        />
                      ) : (
                        <h2 className={styles.pbDetailTitle} onClick={() => { setPbRenamingId(selectedBoard.id); setPbRenameDraft(selectedBoard.name); }}>{selectedBoard.name}</h2>
                      )}
                      <span className={styles.pbDetailProject}>{proj?.name}</span>
                    </div>
                    <div className={styles.pbDetailMeta}>
                      {pbEditingDate === selectedBoard.id ? (
                        <input
                          type="date"
                          className={styles.input}
                          autoFocus
                          value={pbDateDraft}
                          onChange={e => setPbDateDraft(e.target.value)}
                          onBlur={() => savePbDate(selectedBoard.id)}
                          onKeyDown={e => { if (e.key === "Enter") savePbDate(selectedBoard.id); if (e.key === "Escape") setPbEditingDate(null); }}
                        />
                      ) : (
                        <button className={styles.pbDateBtn} onClick={() => { setPbEditingDate(selectedBoard.id); setPbDateDraft(selectedBoard.date); }}>{selectedBoard.date}</button>
                      )}
                      <span className={styles.pbDetailProgress}>{doneCount}/{boardTasks.length} done</span>
                      {selectedBoard.wrapped && <span className={styles.pbWrappedBadge}>✓ Wrapped</span>}
                    </div>
                    {/* Progress bar */}
                    <div className={styles.pbDetailBar}>
                      <div className={styles.pbDetailBarFill} style={{ width: boardTasks.length ? `${(doneCount / boardTasks.length) * 100}%` : "0%" }} />
                    </div>
                    {/* Actions */}
                    {!selectedBoard.wrapped && (
                      <div className={styles.pbDetailActions}>
                        {!pbWrapMode && <button className={styles.btnOutline} onClick={openPbWrapUp}>Wrap up board</button>}
                        <button className={`${styles.deleteBtn}`} onClick={() => { if (window.confirm("Delete this board?")) deletePb(selectedBoard.id); }} title="Delete board">🗑</button>
                      </div>
                    )}
                    {selectedBoard.wrapped && (
                      <div className={styles.pbDetailActions}>
                        <button className={`${styles.deleteBtn}`} onClick={() => { if (window.confirm("Delete this board?")) deletePb(selectedBoard.id); }} title="Delete board">🗑</button>
                      </div>
                    )}
                  </div>

                  {/* Wrap-up panel */}
                  {pbWrapMode && (
                    <div className={styles.wrapPanel}>
                      <div className={styles.wrapPanelHeader}>
                        <span className={styles.wrapPanelTitle}>Wrap up "{selectedBoard.name}"</span>
                        <button className={styles.subtaskCancelBtn} onClick={() => setPbWrapMode(false)}>Cancel</button>
                      </div>
                      <p className={styles.wrapPanelSub}>Mark incomplete tasks as resolved or carry them over.</p>
                      {boardTasks.filter(t => !t.done).map(task => {
                        const isResolve = pbWrapResolveIds.has(task.id);
                        const isCarry = pbWrapCarryIds.has(task.id);
                        const pClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                        return (
                          <div key={task.id} className={styles.wrapItem}>
                            <span className={`${styles.priority} ${pClass}`}>{task.priority}</span>
                            <span className={styles.wrapItemTitle}>{task.title}</span>
                            <button className={`${styles.wrapBtn} ${isResolve ? styles.wrapBtnActive : ""}`}
                              onClick={() => { togglePbWrapId(setPbWrapResolveIds, task.id); if (!isResolve) setPbWrapCarryIds(prev => { const n = new Set(prev); n.delete(task.id); return n; }); }}>
                              ✓ Resolve
                            </button>
                            <button className={`${styles.wrapBtn} ${isCarry ? styles.wrapBtnCarry : ""}`}
                              onClick={() => { togglePbWrapId(setPbWrapCarryIds, task.id); if (!isCarry) setPbWrapResolveIds(prev => { const n = new Set(prev); n.delete(task.id); return n; }); }}>
                              → Carry
                            </button>
                          </div>
                        );
                      })}
                      {boardTasks.filter(t => !t.done).length === 0 && (
                        <p className={styles.empty}>All tasks are done — ready to wrap up!</p>
                      )}
                      <div className={styles.wrapPanelFooter}>
                        <button className={styles.btn} onClick={confirmPbWrapUp}>Confirm wrap-up</button>
                      </div>
                    </div>
                  )}

                  {/* Task list */}
                  {!pbWrapMode && (
                    <ul className={styles.pbTaskList}>
                      {boardTasks.length === 0 && <p className={styles.empty}>No tasks on this board.</p>}
                      {boardTasks.map(task => {
                        const pClass = task.priority === "High" ? styles.priorityHigh : task.priority === "Medium" ? styles.priorityMedium : styles.priorityLow;
                        const notesLocked = isTaskNotesLocked(task);
                        return (
                          <li key={task.id} className={`${styles.pbTaskItem} ${task.done ? styles.pbTaskItemDone : ""}`}>
                            <button
                              className={`${styles.checkBtn} ${task.done ? styles.checked : ""}`}
                              onClick={() => togglePbTaskDone(task.id)}
                              title={task.done ? "Mark active" : "Mark done"}
                            >{task.done ? "✓" : ""}</button>
                            <div className={styles.pbTaskBody}>
                              <span className={styles.pbTaskTitle}>{task.title}</span>
                              <div className={styles.taskMeta}>
                                <span className={`${styles.priority} ${pClass}`}>{task.priority}</span>
                                {task.eta && <span className={styles.eta}>due {task.eta}</span>}
                              </div>
                              {task.notes && !notesLocked && (
                                <div className={styles.pbTaskNotes}>{task.notes.split("\n")[0]}</div>
                              )}
                              {task.notes && notesLocked && (
                                <div className={styles.notesLockedHint} onClick={() => openLockDialog(task.projectId, "unlock", task.id)}>
                                  🔒 Notes hidden — click to unlock
                                </div>
                              )}
                            </div>
                            {!selectedBoard.wrapped && (
                              <button className={styles.deleteBtn} onClick={() => togglePbTask(task.id)} title="Remove from board">×</button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {/* ── Topics ── */}
        {tab === "topics" && (
          <>
            <form className={styles.addForm} onSubmit={handleAddTopic}>
              <input className={styles.input} placeholder="New topic (e.g. Rust, LLMs, TypeScript…)" value={newTopicName} onChange={e => setNewTopicName(e.target.value)} />
              <button className={styles.btn} type="submit">Subscribe</button>
            </form>
            <p className={styles.topicsNote}>
              Subscribed topics are fetched from Hacker News each Friday and included in your learning digest. Pause a topic to skip it without removing it.
            </p>
            {topics.length === 0 ? (
              <p className={styles.empty}>No topics yet. Add one above to get weekly HN summaries every Friday.</p>
            ) : (
              <ul className={styles.topicList}>
                {topics.map(topic => (
                  <li key={topic.id} className={styles.topicItem}>
                    <div className={styles.topicBody}>
                      <span className={styles.topicName}>{topic.name}</span>
                      <span className={styles.topicMeta}>added {topic.addedAt}</span>
                    </div>
                    <button className={`${styles.trackBtn} ${topic.trackWeekly ? styles.trackOn : styles.trackOff}`} onClick={() => handleToggleTracking(topic.id)}>
                      {topic.trackWeekly ? "✅ subscribed" : "⏸ paused"}
                    </button>
                    <button className={styles.deleteBtn} onClick={() => handleDeleteTopic(topic.id)} title="Remove topic">×</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* ── Settings ── */}
        {tab === "settings" && (
          <div className={styles.settingsPage}>
            <section className={styles.settingsSection}>
              <div className={styles.settingsSectionHeader}>
                <div>
                  <h2 className={styles.settingsSectionTitle}>Bot Jobs</h2>
                  <p className={styles.settingsNote}>
                    Scheduled Discord notifications. Changes are saved to the DB and take effect after
                    <code className={styles.code}>pm2 restart memo-assistant</code>.
                  </p>
                </div>
                <button className={styles.btnOutline} onClick={startAddJob}>+ Add job</button>
              </div>

              <div className={styles.jobList}>
                {jobs.map(job => {
                  const isEditing = editingJobId === job.id || (addingJob && editingJobDraft?.id === job.id);
                  const draft = isEditing ? editingJobDraft! : job;
                  return (
                    <div key={job.id} className={`${styles.jobRow} ${!job.enabled && !isEditing ? styles.jobDisabled : ""}`}>
                      {/* Summary row */}
                      <div className={styles.jobSummary}>
                        <button
                          className={`${styles.jobToggle} ${job.enabled ? styles.jobToggleOn : styles.jobToggleOff}`}
                          onClick={() => toggleJobEnabled(job.id)}
                          title={job.enabled ? "Disable" : "Enable"}
                        >{job.enabled ? "●" : "○"}</button>
                        <div className={styles.jobInfo}>
                          <span className={styles.jobName}>{job.name}</span>
                          <span className={`${styles.jobTypeBadge} ${job.type === "digest" ? styles.jobTypeDigest : styles.jobTypeLearn}`}>
                            {job.type === "digest" ? "DIGEST" : "LEARNING"}
                          </span>
                          <span className={styles.jobCronLabel}>{cronToHuman(job.cron)}</span>
                        </div>
                        <div className={styles.jobActions}>
                          {!isEditing && <button className={styles.btnSmall} onClick={() => startEditJob(job)}>Edit</button>}
                          <button className={styles.deleteBtn} onClick={() => deleteJob(job.id)}>×</button>
                        </div>
                      </div>

                      {/* Inline edit form */}
                      {isEditing && editingJobDraft && (
                        <div className={styles.jobEditForm}>
                          <div className={styles.jobEditRow}>
                            <label className={styles.jobEditLabel}>Name</label>
                            <input className={styles.input} value={editingJobDraft.name}
                              onChange={e => setEditingJobDraft(d => d ? { ...d, name: e.target.value } : d)} />
                          </div>
                          <div className={styles.jobEditRow}>
                            <label className={styles.jobEditLabel}>Type</label>
                            <select className={styles.select} value={editingJobDraft.type}
                              onChange={e => setEditingJobDraft(d => d ? { ...d, type: e.target.value as BotJob["type"] } : d)}>
                              <option value="digest">Digest — AI summary of your active tasks</option>
                              <option value="learning">Learning — HN picks + subscribed topic updates</option>
                            </select>
                          </div>
                          <div className={styles.jobEditRow}>
                            <label className={styles.jobEditLabel}>Schedule</label>
                            <div className={styles.jobEditCronGroup}>
                              <input className={`${styles.input} ${styles.cronInputInline}`} value={editingJobDraft.cron} spellCheck={false}
                                onChange={e => setEditingJobDraft(d => d ? { ...d, cron: e.target.value } : d)} />
                              <span className={styles.cronHint}>{cronToHuman(editingJobDraft.cron)}</span>
                            </div>
                          </div>
                          {editingJobDraft.type === "digest" && (
                            <>
                              <div className={styles.jobEditRow}>
                                <label className={styles.jobEditLabel}>Project</label>
                                <select className={styles.select} value={editingJobDraft.projectFilter ?? ""}
                                  onChange={e => setEditingJobDraft(d => d ? { ...d, projectFilter: e.target.value || null } : d)}>
                                  <option value="">All projects</option>
                                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                              </div>
                              <div className={styles.jobEditRow}>
                                <label className={styles.jobEditLabel}>Priority</label>
                                <select className={styles.select} value={editingJobDraft.priorityFilter ?? "All"}
                                  onChange={e => setEditingJobDraft(d => d ? { ...d, priorityFilter: e.target.value as BotJob["priorityFilter"] } : d)}>
                                  <option>All</option><option>High</option><option>Medium</option><option>Low</option>
                                </select>
                              </div>
                            </>
                          )}
                          {editingJobDraft.type === "learning" && (
                            <div className={styles.jobEditNote}>
                              Uses topics subscribed in the <button className={styles.linkBtn} onClick={() => setTab("topics")}>Topics tab</button>.
                              Fetches latest HN stories + AI summaries for each subscribed topic every Friday.
                            </div>
                          )}
                          <div className={styles.jobEditActions}>
                            <button className={styles.btn} onClick={saveEditJob}>{addingJob ? "Add" : "Save"}</button>
                            <button className={styles.subtaskCancelBtn} onClick={cancelJobEdit}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* New job form (if addingJob but no existing ID matches) */}
                {addingJob && editingJobDraft && !jobs.find(j => j.id === editingJobDraft.id) && (
                  <div className={styles.jobRow}>
                    <div className={styles.jobEditForm}>
                      <div className={styles.jobEditRow}>
                        <label className={styles.jobEditLabel}>Name</label>
                        <input className={styles.input} value={editingJobDraft.name} autoFocus
                          onChange={e => setEditingJobDraft(d => d ? { ...d, name: e.target.value } : d)} />
                      </div>
                      <div className={styles.jobEditRow}>
                        <label className={styles.jobEditLabel}>Type</label>
                        <select className={styles.select} value={editingJobDraft.type}
                          onChange={e => setEditingJobDraft(d => d ? { ...d, type: e.target.value as BotJob["type"] } : d)}>
                          <option value="digest">Digest — AI summary of your active tasks</option>
                          <option value="learning">Learning — HN picks + subscribed topic updates</option>
                        </select>
                      </div>
                      <div className={styles.jobEditRow}>
                        <label className={styles.jobEditLabel}>Schedule</label>
                        <div className={styles.jobEditCronGroup}>
                          <input className={`${styles.input} ${styles.cronInputInline}`} value={editingJobDraft.cron} spellCheck={false}
                            onChange={e => setEditingJobDraft(d => d ? { ...d, cron: e.target.value } : d)} />
                          <span className={styles.cronHint}>{cronToHuman(editingJobDraft.cron)}</span>
                        </div>
                      </div>
                      {editingJobDraft.type === "digest" && (
                        <>
                          <div className={styles.jobEditRow}>
                            <label className={styles.jobEditLabel}>Project</label>
                            <select className={styles.select} value={editingJobDraft.projectFilter ?? ""}
                              onChange={e => setEditingJobDraft(d => d ? { ...d, projectFilter: e.target.value || null } : d)}>
                              <option value="">All projects</option>
                              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                          <div className={styles.jobEditRow}>
                            <label className={styles.jobEditLabel}>Priority</label>
                            <select className={styles.select} value={editingJobDraft.priorityFilter ?? "All"}
                              onChange={e => setEditingJobDraft(d => d ? { ...d, priorityFilter: e.target.value as BotJob["priorityFilter"] } : d)}>
                              <option>All</option><option>High</option><option>Medium</option><option>Low</option>
                            </select>
                          </div>
                        </>
                      )}
                      <div className={styles.jobEditActions}>
                        <button className={styles.btn} onClick={saveEditJob}>Add job</button>
                        <button className={styles.subtaskCancelBtn} onClick={cancelJobEdit}>Cancel</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.settingsSaveBar}>
                <button className={`${styles.btn} ${settingsSaved ? styles.btnSaved : ""}`} onClick={handleSaveJobs}>
                  {settingsSaved ? "✓ Saved to DB" : "Save & apply"}
                </button>
                <span className={styles.settingsSaveNote}>Restart the bot process after saving for changes to take effect.</span>
              </div>
            </section>

            {/* ── Projects section ── */}
            <section className={styles.settingsSection}>
              <div className={styles.settingsSectionHeader}>
                <div>
                  <h2 className={styles.settingsSectionTitle}>Projects</h2>
                  <p className={styles.settingsNote}>Create and manage your projects. Tasks and daily board entries are scoped to projects.</p>
                </div>
              </div>
              <form className={styles.projectAddForm} onSubmit={handleAddProject}>
                <input
                  className={styles.input}
                  placeholder="New project name…"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                />
                <button className={styles.btn} type="submit">Add Project</button>
              </form>
              <ul className={styles.projectList}>
                {projects.map((p, i) => {
                  const isLocked = !!(p.private && !unlockedProjects.has(p.id));
                  const isPrivate = !!p.private;
                  return (
                    <li key={p.id} className={`${styles.projectListItem} ${isPrivate ? styles.projectListPrivate : ""}`}>
                      <span className={styles.projectDot} style={{ background: PROJECT_COLORS[i % PROJECT_COLORS.length] }} />
                      <span className={styles.projectListName}>
                        {isPrivate && <span className={styles.projectLockIcon}>{isLocked ? "🔒" : "🔓"}</span>}
                        {p.name}
                      </span>
                      <span className={styles.projectListCount}>{state.tasks.filter(t => t.projectId === p.id).length} tasks</span>
                      {/* Lock controls */}
                      {isPrivate && isLocked && (
                        <button className={styles.btnSmall} onClick={() => openLockDialog(p.id, "unlock")} title="Reveal all notes">Show notes</button>
                      )}
                      {isPrivate && !isLocked && (
                        <>
                          <button className={styles.btnSmall} onClick={() => handleLockProject(p.id)} title="Lock notes">Lock</button>
                          <button className={styles.btnSmall} onClick={() => openLockDialog(p.id, "changePassword")} title="Change password">Password</button>
                        </>
                      )}
                      {!isPrivate && (
                        <button className={styles.btnSmall} onClick={() => openLockDialog(p.id, "setPassword")} title="Add password lock">+ Lock</button>
                      )}
                      {/* Per-project notes expiry (only shown for locked projects) */}
                      {isPrivate && (
                        <div className={styles.projectLockExpiry}>
                          <span className={styles.projectLockExpiryLabel}>Notes expire after</span>
                          <select
                            className={styles.selectXs}
                            value={p.lockSessionDays ?? ""}
                            onChange={async e => {
                              const val = e.target.value;
                              const updated = state.projects.map(proj =>
                                proj.id === p.id
                                  ? { ...proj, lockSessionDays: val === "" ? undefined : Number(val) }
                                  : proj
                              );
                              await persist({ ...state, projects: updated });
                            }}
                          >
                            <option value="">Use default</option>
                            <option value={0.042}>1 hour</option>
                            <option value={0.25}>6 hours</option>
                            <option value={0.5}>12 hours</option>
                            <option value={1}>1 day</option>
                            <option value={3}>3 days</option>
                            <option value={7}>1 week</option>
                            <option value={30}>30 days</option>
                          </select>
                        </div>
                      )}
                      <button className={styles.deleteBtn} onClick={() => handleDeleteProject(p.id)} title="Delete project">×</button>
                    </li>
                  );
                })}
              </ul>

              {/* Default lock session expiry (applies to locked projects that don't have per-project override) */}
              <div className={styles.lockSessionRow}>
                <span className={styles.lockSessionLabel}>📅 ETA warning window</span>
                <select
                  className={styles.select}
                  value={state.settings?.etaWarningDays ?? 3}
                  onChange={async e => {
                    if (!state) return;
                    const days = Number(e.target.value);
                    await persist({ ...state, settings: { ...(state.settings ?? { jobs: [] }), etaWarningDays: days } });
                  }}
                >
                  <option value={1}>1 day before</option>
                  <option value={2}>2 days before</option>
                  <option value={3}>3 days before (default)</option>
                  <option value={5}>5 days before</option>
                  <option value={7}>7 days before</option>
                  <option value={14}>14 days before</option>
                </select>
                <span className={styles.lockSessionNote}>Tasks due within this window are highlighted and floated to the top of the board and project lists.</span>
              </div>

              <div className={styles.lockSessionRow}>
                <span className={styles.lockSessionLabel}>🔒 Default notes-unlock expires after</span>
                <select
                  className={styles.select}
                  value={state.settings?.lockSessionDays ?? 1}
                  onChange={async e => {
                    if (!state) return;
                    const days = Number(e.target.value);
                    await persist({ ...state, settings: { ...(state.settings ?? { jobs: [] }), lockSessionDays: days } });
                  }}
                >
                  <option value={0.042}>1 hour</option>
                  <option value={0.25}>6 hours</option>
                  <option value={0.5}>12 hours</option>
                  <option value={1}>1 day (default)</option>
                  <option value={3}>3 days</option>
                  <option value={7}>1 week</option>
                  <option value={30}>30 days</option>
                </select>
                <span className={styles.lockSessionNote}>Applied to locked projects without a per-project override.</span>
              </div>
            </section>

            {/* ── Data Backup & Restore ── */}
            <section className={styles.settingsSection}>
              <div className={styles.settingsSectionHeader}>
                <div>
                  <h2 className={styles.settingsSectionTitle}>💾 Data Backup & Restore</h2>
                  <p className={styles.settingsNote}>Export all your data as a JSON file you can save locally. Restore from any previous backup — this replaces all current data.</p>
                </div>
              </div>
              <div className={styles.backupRow}>
                <div className={styles.backupCard}>
                  <div className={styles.backupCardTitle}>⬇ Backup</div>
                  <p className={styles.backupCardDesc}>
                    Download a full snapshot of your workspace.
                    {state && <> Includes <strong>{state.tasks.length}</strong> tasks, <strong>{state.projects.length}</strong> projects, <strong>{state.dailyBoards?.length ?? 0}</strong> daily boards, <strong>{state.learningTopics?.length ?? 0}</strong> topics.</>}
                  </p>
                  <button className={styles.btn} onClick={handleExport}>Download backup JSON</button>
                </div>
                <div className={styles.backupCard}>
                  <div className={styles.backupCardTitle}>⬆ Restore</div>
                  <p className={styles.backupCardDesc}>Upload a FlowDesk backup JSON file. You'll be asked to confirm before anything is replaced.</p>
                  <input ref={restoreInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleRestoreFileChange} />
                  <button className={styles.btnOutline} onClick={() => restoreInputRef.current?.click()}>Choose backup file…</button>
                </div>
              </div>
              {restorePreview && (
                <div className={styles.restoreConfirm}>
                  <div className={styles.restoreConfirmInfo}>
                    <span className={styles.restoreConfirmIcon}>⚠️</span>
                    <div>
                      <strong>Restore from &quot;{restoreFileName}&quot;?</strong>
                      <div className={styles.restoreConfirmDetails}>
                        This backup contains <strong>{restorePreview.tasks?.length ?? 0}</strong> tasks,{" "}
                        <strong>{restorePreview.projects?.length ?? 0}</strong> projects,{" "}
                        <strong>{restorePreview.dailyBoards?.length ?? 0}</strong> daily boards, and{" "}
                        <strong>{restorePreview.learningTopics?.length ?? 0}</strong> topics.
                        Your current data will be completely replaced.
                      </div>
                    </div>
                  </div>
                  <div className={styles.restoreConfirmActions}>
                    <button className={`${styles.btn} ${styles.btnDanger}`} onClick={confirmRestore}>Yes, restore now</button>
                    <button className={styles.subtaskCancelBtn} onClick={() => { setRestorePreview(null); setRestoreFileName(""); }}>Cancel</button>
                  </div>
                </div>
              )}
            </section>

            {/* ── Development Checklist ── */}
            <section className={styles.settingsSection}>
              <div className={styles.settingsSectionHeader}>
                <div>
                  <h2 className={styles.settingsSectionTitle}>🗺️ Development Roadmap</h2>
                  <p className={styles.settingsNote}>Planned features and future improvements.</p>
                </div>
              </div>
              <ul className={styles.devChecklist}>
                {[
                  { done: true,  label: "Daily board — task selection & priority sort" },
                  { done: true,  label: "Daily board — drag-to-reorder ranking" },
                  { done: true,  label: "Daily board — wrap up day with boost carry-over" },
                  { done: true,  label: "Daily board — wrap-up panel: resolve & carry-over selection" },
                  { done: true,  label: "Daily board — quick-add task (carries into Memo)" },
                  { done: true,  label: "Daily board — board history view (past days)" },
                  { done: true,  label: "Inline task editing — title + notes on click" },
                  { done: true,  label: "Priority cycle button on task cards" },
                  { done: true,  label: "Project management — create & delete projects" },
                  { done: true,  label: "Search in task list & daily setup" },
                  { done: true,  label: "Theme picker — sidebar follows theme" },
                  { done: true,  label: "Feature parity — subtask count & output pill on daily board" },
                  { done: false, label: "Retro mode — review past boards, celebrate wins, identify blockers" },
                  { done: false, label: "Daily board — summary stats (streak, completion rate)" },
                  { done: false, label: "Task dependencies — block/unblock flow" },
                  { done: false, label: "Recurring tasks — daily / weekly repeats" },
                  { done: false, label: "Export — download tasks as CSV or markdown" },
                  { done: false, label: "Mobile-friendly layout" },
                ].map((item, i) => (
                  <li key={i} className={`${styles.devChecklistItem} ${item.done ? styles.devChecklistDone : ""}`}>
                    <span className={styles.devChecklistIcon}>{item.done ? "✅" : "⬜"}</span>
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

          </main>
        </div>

        {/* Mobile bottom tab bar */}
        {isMobile && (
          <nav className={styles.mobileBottomNav}>
            <button className={`${styles.mobileNavTab} ${tab === "tasks" ? styles.mobileNavTabActive : ""}`} onClick={() => setTab("tasks")}>
              <span className={styles.mobileNavIcon}>📋</span>
              <span className={styles.mobileNavLabel}>Tasks</span>
              {activeTasks.length > 0 && <span className={styles.mobileNavBadge}>{activeTasks.length}</span>}
            </button>
            <button className={`${styles.mobileNavTab} ${tab === "today" ? styles.mobileNavTabActive : ""}`} onClick={switchToToday}>
              <span className={styles.mobileNavIcon}>⚡</span>
              <span className={styles.mobileNavLabel}>Today</span>
              {todayBoard && boardTaskObjects.filter(t => !t.done).length > 0 && <span className={styles.mobileNavBadge}>{boardTaskObjects.filter(t => !t.done).length}</span>}
            </button>
            <button className={`${styles.mobileNavTab} ${tab === "boards" ? styles.mobileNavTabActive : ""}`} onClick={() => { setTab("boards"); setPbView("list"); }}>
              <span className={styles.mobileNavIcon}>📁</span>
              <span className={styles.mobileNavLabel}>Boards</span>
            </button>
            <button className={`${styles.mobileNavTab} ${tab === "topics" ? styles.mobileNavTabActive : ""}`} onClick={() => setTab("topics")}>
              <span className={styles.mobileNavIcon}>📚</span>
              <span className={styles.mobileNavLabel}>Topics</span>
            </button>
            <button className={`${styles.mobileNavTab} ${tab === "settings" ? styles.mobileNavTabActive : ""}`} onClick={() => setTab("settings")}>
              <span className={styles.mobileNavIcon}>⚙️</span>
              <span className={styles.mobileNavLabel}>More</span>
            </button>
          </nav>
        )}
      </div>

      {/* ── Mobile / Web view toggle ── */}
      <div className={styles.viewToggle}>
        <button
          className={`${styles.viewToggleBtn} ${isMobile ? styles.viewToggleBtnActive : ""}`}
          onClick={() => setIsMobileOverride(true)}
          title="Mobile layout"
        >📱 Mobile</button>
        <button
          className={`${styles.viewToggleBtn} ${!isMobile ? styles.viewToggleBtnActive : ""}`}
          onClick={() => setIsMobileOverride(false)}
          title="Web layout"
        >🖥 Web</button>
      </div>

      {/* ── Lock Dialog Modal ── */}
      {lockDialog && (() => {
        const proj = state?.projects.find(p => p.id === lockDialog.projectId);
        const mode = lockDialog.mode;
        const isPerTask = !!lockDialog.taskId;
        const taskForUnlock = isPerTask ? state?.tasks.find(t => t.id === lockDialog.taskId) : null;
        return (
          <div className={styles.lockOverlay} onClick={() => setLockDialog(null)}>
            <div className={styles.lockModal} onClick={e => e.stopPropagation()}>
              <div className={styles.lockModalHeader}>
                <span className={styles.lockModalIcon}>
                  {mode === "unlock" ? "🔓" : mode === "forgot" || mode === "verifyOtp" ? "📧" : "🔒"}
                </span>
                <div>
                  <h3 className={styles.lockModalTitle}>
                    {mode === "unlock" && isPerTask && `Unlock notes — "${taskForUnlock?.title ?? "task"}"`}
                    {mode === "unlock" && !isPerTask && `Show all notes — "${proj?.name}"`}
                    {mode === "setPassword" && `Lock "${proj?.name}"`}
                    {mode === "changePassword" && `Change password — "${proj?.name}"`}
                    {mode === "forgot" && `Forgot password — "${proj?.name}"`}
                    {mode === "verifyOtp" && "Enter verification code"}
                  </h3>
                  {mode === "setPassword" && <p className={styles.lockModalSub}>Create a password to protect this project&apos;s notes. Task titles remain visible.</p>}
                  {mode === "unlock" && isPerTask && <p className={styles.lockModalSub}>Enter the project password to reveal notes for this task.</p>}
                  {mode === "unlock" && !isPerTask && <p className={styles.lockModalSub}>Enter the project password to reveal notes for all tasks in &quot;{proj?.name}&quot;.</p>}
                </div>
                <button className={styles.lockModalClose} onClick={() => setLockDialog(null)}>×</button>
              </div>

              {/* Unlock */}
              {mode === "unlock" && (
                <div className={styles.lockModalBody}>
                  <input className={styles.input} type="password" placeholder="Password" autoFocus
                    value={lockPassword} onChange={e => { setLockPassword(e.target.value); setLockError(""); }}
                    onKeyDown={e => e.key === "Enter" && handleUnlockProject()} />
                  {lockError && <div className={styles.lockError}>{lockError}</div>}
                  <div className={styles.lockModalActions}>
                    <button className={styles.btn} onClick={handleUnlockProject}>{isPerTask ? "Unlock notes" : "Show all notes"}</button>
                    <button className={styles.linkBtn} onClick={() => setLockDialog({ ...lockDialog, mode: "forgot" })}>Forgot password?</button>
                  </div>
                </div>
              )}

              {/* Set / Change password */}
              {(mode === "setPassword" || mode === "changePassword") && (
                <div className={styles.lockModalBody}>
                  <label className={styles.lockLabel}>New password</label>
                  <input className={styles.input} type="password" placeholder="At least 4 characters" autoFocus
                    value={lockPassword} onChange={e => { setLockPassword(e.target.value); setLockError(""); }} />
                  <label className={styles.lockLabel}>Confirm password</label>
                  <input className={styles.input} type="password" placeholder="Repeat password"
                    value={lockPasswordConfirm} onChange={e => { setLockPasswordConfirm(e.target.value); setLockError(""); }}
                    onKeyDown={e => e.key === "Enter" && handleSetProjectPassword()} />
                  <label className={styles.lockLabel}>Recovery email <span className={styles.lockLabelOptional}>(optional — for forgot password)</span></label>
                  <input className={styles.input} type="email" placeholder="you@example.com"
                    value={lockRecoveryEmail} onChange={e => setLockRecoveryEmail(e.target.value)} />
                  {lockError && <div className={styles.lockError}>{lockError}</div>}
                  <div className={styles.lockModalActions}>
                    <button className={styles.btn} onClick={handleSetProjectPassword}>
                      {mode === "setPassword" ? "Lock project" : "Update password"}
                    </button>
                    {mode === "changePassword" && (
                      <button className={styles.btnOutline} onClick={handleRemoveProjectPassword}>Remove lock</button>
                    )}
                  </div>
                </div>
              )}

              {/* Forgot password — enter email & send OTP */}
              {mode === "forgot" && (
                <div className={styles.lockModalBody}>
                  <p className={styles.lockModalSub}>We&apos;ll send a 6-digit code to your recovery email so you can reset the password.</p>
                  {proj?.recoveryEmail && (
                    <div className={styles.lockRecoveryHint}>Recovery email on file: <strong>{proj.recoveryEmail}</strong></div>
                  )}
                  {!proj?.recoveryEmail && (
                    <>
                      <label className={styles.lockLabel}>Recovery email</label>
                      <input className={styles.input} type="email" placeholder="you@example.com" autoFocus
                        value={lockRecoveryEmail} onChange={e => { setLockRecoveryEmail(e.target.value); setLockError(""); }} />
                    </>
                  )}
                  {lockError && <div className={styles.lockError}>{lockError}</div>}
                  <div className={styles.lockModalActions}>
                    <button className={styles.btn} onClick={handleSendOtp} disabled={lockOtpLoading}>
                      {lockOtpLoading ? "Sending…" : "Send code"}
                    </button>
                    <button className={styles.linkBtn} onClick={() => setLockDialog({ ...lockDialog, mode: "unlock" })}>← Back</button>
                  </div>
                </div>
              )}

              {/* Verify OTP + set new password */}
              {mode === "verifyOtp" && (
                <div className={styles.lockModalBody}>
                  <p className={styles.lockModalSub}>Enter the 6-digit code sent to <strong>{lockRecoveryEmail}</strong> and set a new password.</p>
                  <label className={styles.lockLabel}>Verification code</label>
                  <input className={styles.input} type="text" placeholder="123456" autoFocus maxLength={6}
                    value={lockOtp} onChange={e => { setLockOtp(e.target.value.replace(/\D/g, "")); setLockError(""); }} />
                  <label className={styles.lockLabel}>New password</label>
                  <input className={styles.input} type="password" placeholder="At least 4 characters"
                    value={lockPassword} onChange={e => { setLockPassword(e.target.value); setLockError(""); }} />
                  <label className={styles.lockLabel}>Confirm password</label>
                  <input className={styles.input} type="password" placeholder="Repeat password"
                    value={lockPasswordConfirm} onChange={e => { setLockPasswordConfirm(e.target.value); setLockError(""); }}
                    onKeyDown={e => e.key === "Enter" && handleVerifyOtp()} />
                  {lockError && <div className={styles.lockError}>{lockError}</div>}
                  <div className={styles.lockModalActions}>
                    <button className={styles.btn} onClick={handleVerifyOtp} disabled={lockOtpLoading}>
                      {lockOtpLoading ? "Verifying…" : "Reset password"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
