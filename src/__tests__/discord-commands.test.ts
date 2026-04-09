import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdirSync, closeSync, openSync } from "fs";
import { join } from "path";

// ─── Hoisted shared state ─────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => ({ state: null as Record<string, unknown> | null }));
const handlers = vi.hoisted(() => ({
  once: {} as Record<string, (...args: unknown[]) => unknown>,
  on:   {} as Record<string, (...args: unknown[]) => unknown>,
}));

// ─── Global fetch mock ────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── node-cron: no-op ─────────────────────────────────────────────────────────
vi.mock("node-cron", () => ({ default: { schedule: vi.fn() }, schedule: vi.fn() }));

// ─── discord.js ───────────────────────────────────────────────────────────────
vi.mock("discord.js", () => ({
  // Must be a real function (not arrow) so `new Client()` works as a constructor
  Client: vi.fn(function () {
    return {
      once:     vi.fn((e: string, fn: (...a: unknown[]) => unknown) => { handlers.once[e] = fn; }),
      on:       vi.fn((e: string, fn: (...a: unknown[]) => unknown) => { handlers.on[e]   = fn; }),
      login:    vi.fn().mockResolvedValue(undefined),
      user:     { tag: "TestBot#0000" },
      channels: { fetch: vi.fn().mockResolvedValue({ send: vi.fn() }) },
    };
  }),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768 },
  TextChannel: class {},
}));

// ─── better-sqlite3 ───────────────────────────────────────────────────────────
// Must use a real `function` (not arrow) so `new Database()` works as a constructor.
vi.mock("better-sqlite3", () => ({
  default: vi.fn(function MockDatabase() {
    return {
      prepare: () => ({
        get:  () => mockDb.state ? { value: JSON.stringify(mockDb.state) } : undefined,
        run:  (_k: string, val: string) => { mockDb.state = JSON.parse(val); },
      }),
      close: () => {},
      exec:  () => {},
    };
  }),
}));

// ─── Import bot after mocks ───────────────────────────────────────────────────
process.env.DISCORD_BOT_TOKEN  = "test-token";
process.env.DISCORD_CHANNEL_ID = "test-channel";

const { startDiscordBot } = await import("../lib/discord-bot");

const CHANNEL = "test-channel";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeMsg(content: string) {
  const editFn  = vi.fn();
  const replyFn = vi.fn().mockResolvedValue({ edit: editFn });
  return {
    content,
    channelId: CHANNEL,
    author:    { bot: false },
    channel:   { send: vi.fn() },
    reply:     replyFn,
    _edit:     editFn,
  };
}

/** Send a message through the registered handler and return the mock msg. */
async function send(content: string) {
  const msg = makeMsg(content);
  await (handlers.on["messageCreate"] as (m: typeof msg) => Promise<void>)(msg);
  return msg;
}

function groqOk(text = "Mocked AI response") {
  return Promise.resolve({
    ok:   true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
beforeAll(() => {
  // Ensure data/hub.db exists so fs.existsSync(DB_PATH) returns true in getState()
  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  try { closeSync(openSync(join(dataDir, "hub.db"), "a")); } catch { /* already exists */ }

  startDiscordBot();
  // messageCreate is registered directly on client (not inside clientReady)
});

beforeEach(() => {
  mockDb.state = null;
  mockFetch.mockReset();
});

// ─── Ignored messages ─────────────────────────────────────────────────────────
describe("messageCreate — ignored messages", () => {
  it("ignores bot messages", async () => {
    const msg = makeMsg("!help");
    msg.author.bot = true as never;
    await (handlers.on["messageCreate"] as (m: typeof msg) => Promise<void>)(msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores messages from wrong channel", async () => {
    const msg = makeMsg("!help");
    msg.channelId = "other-channel" as never;
    await (handlers.on["messageCreate"] as (m: typeof msg) => Promise<void>)(msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("does not reply to unknown commands", async () => {
    const msg = await send("!unknown");
    expect(msg.reply).not.toHaveBeenCalled();
  });
});

// ─── !help ────────────────────────────────────────────────────────────────────
describe("!help", () => {
  it("replies with the help menu", async () => {
    const msg = await send("!help");
    expect(msg.reply).toHaveBeenCalledOnce();
    const text = (msg.reply.mock.calls[0][0] as string);
    expect(text).toContain("!tasks");
    expect(text).toContain("!addtask");
    expect(text).toContain("!done");
    expect(text).toContain("!digest");
    expect(text).toContain("!learn");
  });

  it("is case-insensitive", async () => {
    const msg = await send("!HELP");
    expect(msg.reply).toHaveBeenCalledOnce();
  });
});

// ─── !tasks ───────────────────────────────────────────────────────────────────
describe("!tasks", () => {
  it("replies with no-data warning when state is null", async () => {
    const msg = await send("!tasks");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("No data");
  });

  it("replies with all-clear when there are no active tasks", async () => {
    mockDb.state = { tasks: [] };
    const msg = await send("!tasks");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("No active tasks");
  });

  it("lists active tasks with priority and title", async () => {
    mockDb.state = {
      tasks: [
        { id: "t1", title: "Fix login bug",  priority: "High", done: false },
        { id: "t2", title: "Write docs",     priority: "Low",  done: false },
        { id: "t3", title: "Already done",   priority: "High", done: true  },
      ],
    };
    const msg = await send("!tasks");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("Fix login bug");
    expect(text).toContain("Write docs");
    expect(text).not.toContain("Already done");
    expect(text).toContain("Active Tasks (2)");
  });

  it("includes ETA when present", async () => {
    mockDb.state = {
      tasks: [{ id: "t1", title: "Deploy", priority: "High", done: false, eta: "2026-04-01" }],
    };
    const msg = await send("!tasks");
    expect(msg.reply.mock.calls[0][0] as string).toContain("2026-04-01");
  });
});

// ─── !addtask (task CRUD — create) ───────────────────────────────────────────
describe("!addtask — task create", () => {
  it("replies with no-state warning when db is empty", async () => {
    const msg = await send("!addtask My new task");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("Could not load state");
  });

  it("creates a new task and confirms", async () => {
    mockDb.state = { tasks: [], projects: [{ id: "p1", name: "Work" }] };
    const msg = await send("!addtask Fix the pipeline");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("Fix the pipeline");
    expect(text).toContain("✅");
  });

  it("persists the new task to state", async () => {
    mockDb.state = { tasks: [], projects: [{ id: "p1", name: "Work" }] };
    await send("!addtask Persist me");
    const tasks = mockDb.state!.tasks as { title: string }[];
    expect(tasks.some(t => t.title === "Persist me")).toBe(true);
  });

  it("new task has done=false and a non-empty id", async () => {
    mockDb.state = { tasks: [], projects: [] };
    await send("!addtask Check audit logs");
    const tasks = mockDb.state!.tasks as { title: string; done: boolean; id: string }[];
    const t = tasks.find(t => t.title === "Check audit logs")!;
    expect(t.done).toBe(false);
    expect(t.id).toBeTruthy();
  });

  it("assigns the first project id when available", async () => {
    mockDb.state = { tasks: [], projects: [{ id: "proj-42", name: "Alpha" }] };
    await send("!addtask Task for project");
    const tasks = mockDb.state!.tasks as { projectId: string; title: string }[];
    expect(tasks.find(t => t.title === "Task for project")!.projectId).toBe("proj-42");
  });

  it("falls back to p_memo when no projects exist", async () => {
    mockDb.state = { tasks: [], projects: [] };
    await send("!addtask Orphan task");
    const tasks = mockDb.state!.tasks as { projectId: string; title: string }[];
    expect(tasks.find(t => t.title === "Orphan task")!.projectId).toBe("p_memo");
  });

  it("preserves title casing", async () => {
    mockDb.state = { tasks: [], projects: [] };
    await send("!addtask MixedCase Title");
    const tasks = mockDb.state!.tasks as { title: string }[];
    expect(tasks[0].title).toBe("MixedCase Title");
  });
});

// ─── !done (task CRUD — update) ──────────────────────────────────────────────
describe("!done — task update", () => {
  it("replies with error when state is null", async () => {
    const msg = await send("!done 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Could not load state");
  });

  it("rejects invalid (non-numeric) task number", async () => {
    mockDb.state = { tasks: [{ id: "t1", title: "Task", done: false }] };
    const msg = await send("!done abc");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Invalid");
  });

  it("rejects out-of-range task number", async () => {
    mockDb.state = { tasks: [{ id: "t1", title: "Task", done: false }] };
    const msg = await send("!done 99");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Invalid");
  });

  it("marks the task as done and confirms", async () => {
    mockDb.state = {
      tasks: [{ id: "t1", title: "Deploy to prod", done: false }],
    };
    const msg = await send("!done 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Deploy to prod");
    expect(msg.reply.mock.calls[0][0] as string).toContain("✅");
  });

  it("persists done=true in state", async () => {
    mockDb.state = {
      tasks: [{ id: "t1", title: "Write tests", done: false }],
    };
    await send("!done 1");
    const tasks = mockDb.state!.tasks as { id: string; done: boolean }[];
    expect(tasks.find(t => t.id === "t1")!.done).toBe(true);
  });

  it("marks the correct task when multiple active tasks exist", async () => {
    mockDb.state = {
      tasks: [
        { id: "t1", title: "First",  done: false },
        { id: "t2", title: "Second", done: false },
      ],
    };
    await send("!done 2");
    const tasks = mockDb.state!.tasks as { id: string; done: boolean }[];
    expect(tasks.find(t => t.id === "t1")!.done).toBe(false);
    expect(tasks.find(t => t.id === "t2")!.done).toBe(true);
  });

  it("only counts non-done tasks in the index", async () => {
    mockDb.state = {
      tasks: [
        { id: "t1", title: "Already done", done: true  },
        { id: "t2", title: "Active",       done: false },
      ],
    };
    await send("!done 1"); // #1 in active list = t2
    const tasks = mockDb.state!.tasks as { id: string; done: boolean }[];
    expect(tasks.find(t => t.id === "t2")!.done).toBe(true);
  });
});

// ─── !digest ─────────────────────────────────────────────────────────────────
describe("!digest", () => {
  it("sends a warning when there is no state", async () => {
    const msg = await send("!digest");
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("No data"));
  });

  it("sends the digest with AI summary when state exists", async () => {
    mockDb.state = {
      tasks:    [{ id: "t1", title: "Ship feature", priority: "High", done: false }],
      projects: [],
    };
    mockFetch.mockResolvedValueOnce(groqOk("Today focus: ship feature."));
    const msg = await send("!digest");
    expect(msg.reply).toHaveBeenCalledWith("⏳ Generating digest...");
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("Daily Digest"),
    );
  });
});

// ─── !summary ────────────────────────────────────────────────────────────────
describe("!summary", () => {
  it("sends a warning when there is no state", async () => {
    const msg = await send("!summary");
    expect(msg.reply.mock.calls[0][0] as string).toContain("No data");
  });

  it("edits the thinking message with the AI summary", async () => {
    mockDb.state = { tasks: [{ id: "t1", title: "Review PR", priority: "Medium", done: false }] };
    mockFetch.mockResolvedValueOnce(groqOk("Focus on code review today."));
    const msg = await send("!summary");
    expect(msg.reply).toHaveBeenCalledWith("⏳ Thinking...");
    expect(msg._edit).toHaveBeenCalledWith(expect.stringContaining("Focus Summary"));
  });
});

// ─── !learn ──────────────────────────────────────────────────────────────────
describe("!learn", () => {
  it("sends the fetching message then the picks", async () => {
    // HN topstories → 3 IDs
    mockFetch
      .mockResolvedValueOnce({ json: async () => [101, 102, 103] })
      // 3 HN items
      .mockResolvedValueOnce({ json: async () => ({ id: 101, type: "story", title: "Story A", url: "https://a.com", score: 200 }) })
      .mockResolvedValueOnce({ json: async () => ({ id: 102, type: "story", title: "Story B", url: "https://b.com", score: 150 }) })
      .mockResolvedValueOnce({ json: async () => ({ id: 103, type: "story", title: "Story C", url: "https://c.com", score: 100 }) })
      // Groq call
      .mockResolvedValueOnce(groqOk("1. Story A\n2. Story B\n3. Story C"));

    const msg = await send("!learn");
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("fetching"));
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("Friday Learning Picks"));
  });

  it("sends a warning when HN fetch returns no stories", async () => {
    mockFetch
      .mockResolvedValueOnce({ json: async () => [101] })
      .mockResolvedValueOnce({ json: async () => ({ id: 101, type: "job", title: "Hiring", url: "https://x.com", score: 1 }) });

    const msg = await send("!learn");
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("Could not fetch"));
  });

  it("includes topic updates after HN picks when topics exist", async () => {
    mockDb.state = {
      tasks: [],
      projects: [],
      learningTopics: [{ id: "tp1", name: "Rust", addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] }],
    };
    // HN topstories + 1 item + Groq for HN picks + Algolia for Rust + Groq for Rust summary
    mockFetch
      .mockResolvedValueOnce({ json: async () => [1] })
      .mockResolvedValueOnce({ json: async () => ({ id: 1, type: "story", title: "Story A", url: "https://a.com", score: 99 }) })
      .mockResolvedValueOnce(groqOk("Three picks for you."))
      // Algolia hit for "Rust"
      .mockResolvedValueOnce({ json: async () => ({ hits: [{ objectID: "a1", title: "Rust 2024 edition", url: "https://rust.org", points: 200 }] }) })
      .mockResolvedValueOnce(groqOk("Rust has a new edition."));

    const msg = await send("!learn");
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("Topic Updates"));
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining("Rust"));
  });
});

// ─── !topics ─────────────────────────────────────────────────────────────────
describe("!topics", () => {
  it("replies with prompt to add when no topics exist", async () => {
    mockDb.state = { tasks: [], learningTopics: [] };
    const msg = await send("!topics");
    expect(msg.reply.mock.calls[0][0] as string).toContain("!addtopic");
  });

  it("replies with prompt to add when learningTopics is absent", async () => {
    mockDb.state = { tasks: [] };
    const msg = await send("!topics");
    expect(msg.reply.mock.calls[0][0] as string).toContain("!addtopic");
  });

  it("lists all topics with index and weekly status", async () => {
    mockDb.state = {
      learningTopics: [
        { id: "t1", name: "Rust", addedAt: "2026-01-01", trackWeekly: true,  lastSeenIds: [] },
        { id: "t2", name: "LLMs", addedAt: "2026-01-02", trackWeekly: false, lastSeenIds: [] },
      ],
    };
    const msg = await send("!topics");
    const text = msg.reply.mock.calls[0][0] as string;
    expect(text).toContain("Rust");
    expect(text).toContain("LLMs");
    expect(text).toContain("1.");
    expect(text).toContain("2.");
    expect(text).toContain("weekly");
    expect(text).toContain("paused");
  });

  it("returns no-data warning when state is null", async () => {
    const msg = await send("!topics");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Could not load state");
  });
});

// ─── !addtopic ────────────────────────────────────────────────────────────────
describe("!addtopic — add learning topic", () => {
  it("returns no-state warning when db is empty", async () => {
    const msg = await send("!addtopic Rust");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Could not load state");
  });

  it("adds a new topic and confirms", async () => {
    mockDb.state = { tasks: [], learningTopics: [] };
    const msg = await send("!addtopic Rust programming");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Rust programming");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Friday");
  });

  it("persists the topic with trackWeekly=true and empty lastSeenIds", async () => {
    mockDb.state = { tasks: [], learningTopics: [] };
    await send("!addtopic WebAssembly");
    const topics = (mockDb.state!.learningTopics as { name: string; trackWeekly: boolean; lastSeenIds: string[] }[]);
    const t = topics.find(t => t.name === "WebAssembly")!;
    expect(t.trackWeekly).toBe(true);
    expect(t.lastSeenIds).toEqual([]);
  });

  it("preserves topic name casing", async () => {
    mockDb.state = { tasks: [], learningTopics: [] };
    await send("!addtopic LLM Agents");
    const topics = (mockDb.state!.learningTopics as { name: string }[]);
    expect(topics[0].name).toBe("LLM Agents");
  });

  it("rejects duplicate topic names (case-insensitive)", async () => {
    mockDb.state = {
      tasks: [],
      learningTopics: [{ id: "x", name: "Rust", addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] }],
    };
    const msg = await send("!addtopic rust");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Already tracking");
  });

  it("prepends the new topic to the list", async () => {
    mockDb.state = {
      tasks: [],
      learningTopics: [{ id: "x", name: "Existing", addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] }],
    };
    await send("!addtopic Newest");
    const topics = (mockDb.state!.learningTopics as { name: string }[]);
    expect(topics[0].name).toBe("Newest");
  });
});

// ─── !removetopic ────────────────────────────────────────────────────────────
describe("!removetopic — remove learning topic", () => {
  const twoTopics = () => ({
    tasks: [],
    learningTopics: [
      { id: "t1", name: "Rust",  addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] },
      { id: "t2", name: "LLMs",  addedAt: "2026-01-02", trackWeekly: true, lastSeenIds: [] },
    ],
  });

  it("returns no-state warning when db is empty", async () => {
    const msg = await send("!removetopic 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Could not load state");
  });

  it("rejects out-of-range index", async () => {
    mockDb.state = twoTopics();
    const msg = await send("!removetopic 99");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Invalid");
  });

  it("removes the correct topic and confirms", async () => {
    mockDb.state = twoTopics();
    const msg = await send("!removetopic 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Rust");
  });

  it("persists removal in state", async () => {
    mockDb.state = twoTopics();
    await send("!removetopic 1");
    const topics = (mockDb.state!.learningTopics as { name: string }[]);
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe("LLMs");
  });

  it("can remove the last topic, leaving an empty list", async () => {
    mockDb.state = {
      tasks: [],
      learningTopics: [{ id: "t1", name: "Solo", addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] }],
    };
    await send("!removetopic 1");
    expect((mockDb.state!.learningTopics as unknown[]).length).toBe(0);
  });
});

// ─── !trackweekly ────────────────────────────────────────────────────────────
describe("!trackweekly — toggle weekly tracking", () => {
  const oneActiveTopic = () => ({
    tasks: [],
    learningTopics: [
      { id: "t1", name: "Rust", addedAt: "2026-01-01", trackWeekly: true, lastSeenIds: [] },
    ],
  });

  it("returns no-state warning when db is empty", async () => {
    const msg = await send("!trackweekly 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Could not load state");
  });

  it("rejects out-of-range index", async () => {
    mockDb.state = oneActiveTopic();
    const msg = await send("!trackweekly 99");
    expect(msg.reply.mock.calls[0][0] as string).toContain("Invalid");
  });

  it("toggles trackWeekly from true to false", async () => {
    mockDb.state = oneActiveTopic();
    await send("!trackweekly 1");
    const topics = (mockDb.state!.learningTopics as { trackWeekly: boolean }[]);
    expect(topics[0].trackWeekly).toBe(false);
  });

  it("toggles trackWeekly from false to true", async () => {
    mockDb.state = {
      tasks: [],
      learningTopics: [{ id: "t1", name: "Rust", addedAt: "2026-01-01", trackWeekly: false, lastSeenIds: [] }],
    };
    await send("!trackweekly 1");
    const topics = (mockDb.state!.learningTopics as { trackWeekly: boolean }[]);
    expect(topics[0].trackWeekly).toBe(true);
  });

  it("reply contains ON when enabled", async () => {
    mockDb.state = {
      tasks: [],
      learningTopics: [{ id: "t1", name: "Rust", addedAt: "2026-01-01", trackWeekly: false, lastSeenIds: [] }],
    };
    const msg = await send("!trackweekly 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("ON");
  });

  it("reply contains paused when disabled", async () => {
    mockDb.state = oneActiveTopic();
    const msg = await send("!trackweekly 1");
    expect(msg.reply.mock.calls[0][0] as string).toContain("paused");
  });

  it("persists the toggle in state", async () => {
    mockDb.state = oneActiveTopic();
    await send("!trackweekly 1");
    expect((mockDb.state!.learningTopics as { trackWeekly: boolean }[])[0].trackWeekly).toBe(false);
  });
});
