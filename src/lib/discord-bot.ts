import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import cron from "node-cron";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "hub.db");
const STORE_KEY = "phub_v6";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface LearningTopic {
  id: string;
  name: string;
  addedAt: string;       // YYYY-MM-DD
  trackWeekly: boolean;  // false = paused, won't appear on Fridays
  lastSeenIds: string[]; // Algolia objectIDs already shown — prevents week-over-week repeats
}

// ─── State helpers ────────────────────────────────────────────────────────────
function getState() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM store WHERE key = ?").get(STORE_KEY) as { value: string } | undefined;
    db.close();
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

async function saveState(state: Record<string, unknown>) {
  try {
    const db = new Database(DB_PATH);
    db.prepare(
      "INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(STORE_KEY, JSON.stringify(state), new Date().toISOString());
    db.close();
  } catch {}
}

// ─── AI helper ────────────────────────────────────────────────────────────────
async function callGroq(prompt: string): Promise<string> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "No response.";
  } catch (e) {
    return `Error: ${e}`;
  }
}

// ─── Daily digest ─────────────────────────────────────────────────────────────
async function sendDigest(channel: TextChannel, filters: { projectFilter?: string | null; priorityFilter?: string } = {}) {
  const state = getState();
  if (!state) { await channel.send("⚠️ No data found."); return; }

  const allTasks = (state.tasks || []) as Record<string, unknown>[];
  const projects = (state.projects || []) as Record<string, unknown>[];

  let active = allTasks.filter(t => !t.done);
  if (filters.projectFilter) active = active.filter(t => t.projectId === filters.projectFilter || (t.tagProjectIds as string[] ?? []).includes(filters.projectFilter!));
  if (filters.priorityFilter && filters.priorityFilter !== "All") active = active.filter(t => t.priority === filters.priorityFilter);
  const overallPrompt = `You are a productivity assistant. Summarize these active tasks for a daily digest:\n${
    active.map(t => `- [${t.priority}] ${t.title}${t.eta ? ` (due ${t.eta})` : ""}`).join("\n") || "No active tasks."
  }\n\nBe concise, motivating, max 200 words.`;
  const overallSummary = await callGroq(overallPrompt);
  await channel.send(`📋 **Daily Digest — ${new Date().toLocaleDateString()}**\n\n${overallSummary}`);

  const notifyProjects = projects.filter(p => p.notifyDiscord);
  for (const proj of notifyProjects) {
    const projTasks = active.filter(t => t.projectId === proj.id || (t.tagProjectIds as string[] || []).includes(proj.id as string));
    if (!projTasks.length) continue;
    const projPrompt = `Productivity assistant. Summarize tasks for project "${proj.name}":\n${
      projTasks.map(t => `- [${t.priority}] ${t.title}${t.eta ? ` (due ${t.eta})` : ""}`).join("\n")
    }\n\nConcise summary, max 100 words.`;
    const projSummary = await callGroq(projPrompt);
    await channel.send(`📁 **${proj.name}** (${projTasks.length} active)\n${projSummary}`);
  }
}

// ─── HN helpers ───────────────────────────────────────────────────────────────
export async function fetchHNStories(): Promise<{title:string;url:string;score:number}[]> {
  try {
    const ids = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r=>r.json()) as number[];
    const top = ids.slice(0, 40);
    const stories = await Promise.all(
      top.map(id =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
          .then(r => r.json())
          .catch(() => null)
      )
    );
    return stories
      .filter((s): s is {title:string;url:string;score:number;type:string} =>
        s && s.type === "story" && s.url && s.title
      )
      .map(s => ({ title: s.title, url: s.url, score: s.score }));
  } catch { return []; }
}

/** Search HN Algolia for stories about `topic` published in the last 7 days.
 *  Excludes any story whose objectID is in `excludeIds` (deduplication). */
export async function fetchHNAlgolia(
  topic: string,
  excludeIds: string[] = []
): Promise<{ objectID: string; title: string; url: string; points: number }[]> {
  try {
    const params = new URLSearchParams({
      query: topic,
      tags: "story",
      dateRange: "last_7days",
      hitsPerPage: "10",
    });
    const data = await fetch(
      `https://hn.algolia.com/api/v1/search?${params}`
    ).then(r => r.json()) as {
      hits: { objectID: string; title: string; url?: string; points?: number }[];
    };
    return data.hits
      .filter(h => h.title && !excludeIds.includes(h.objectID))
      .map(h => ({
        objectID: h.objectID,
        title: h.title,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points ?? 0,
      }));
  } catch { return []; }
}

// ─── Topic digest helpers ─────────────────────────────────────────────────────

/** Fetch, summarise, and post updates for one topic. Returns the IDs that were shown. */
async function sendTopicDigest(channel: TextChannel, topic: LearningTopic): Promise<string[]> {
  const hits = await fetchHNAlgolia(topic.name, topic.lastSeenIds);

  if (!hits.length) {
    await channel.send(`📌 **${topic.name}** — no new HN stories this week.`);
    return [];
  }

  const top = hits.slice(0, 5);
  const storyList = top
    .map((h, i) => `${i + 1}. [${h.points}pts] ${h.title} — ${h.url}`)
    .join("\n");

  const prompt = `You are a learning curator. Summarize what's new and worth learning about "${topic.name}" based on these recent Hacker News posts from this week:

${storyList}

Write 2-3 sentences covering the key themes or developments, then highlight the 2 most valuable links. Format cleanly for Discord markdown. Max 150 words.`;

  const summary = await callGroq(prompt);
  await channel.send(`📌 **${topic.name}** (${top.length} new ${top.length === 1 ? "story" : "stories"})\n${summary}`);
  return top.map(h => h.objectID);
}

/** Build the "keep tracking?" prompt shown at the end of each Friday topic run. */
export function buildTrackingPrompt(topics: LearningTopic[]): string {
  const list = topics
    .map((t, i) => `${i + 1}. **${t.name}** — ${t.trackWeekly ? "✅ weekly" : "⏸ paused"}`)
    .join("\n");
  return (
    "💡 **Your tracked topics:**\n" +
    list +
    "\n\nUse `!trackweekly <n>` to pause/resume, `!removetopic <n>` to remove permanently."
  );
}

// ─── Friday learning ──────────────────────────────────────────────────────────
async function sendFridayLearning(channel: TextChannel) {
  await channel.send("📚 **Friday Learning Picks** — fetching this week's best reads…");

  const stories = await fetchHNStories();
  if (!stories.length) {
    await channel.send("⚠️ Could not fetch stories from Hacker News.");
    return;
  }

  const storyList = stories
    .slice(0, 30)
    .map((s, i) => `${i + 1}. [score:${s.score}] ${s.title} — ${s.url}`)
    .join("\n");

  const prompt = `You are a curated learning digest. From the list below, pick exactly 3 items that would make excellent 30-minute self-study sessions.

Prefer: AI/ML research, deep-dives into well-known systems (databases, networking, OS, compilers), remarkable new tech launches, or insightful engineering blog posts. Avoid: job posts, startup pitches, news, politics.

For each pick, write:
- **Title** (with the URL as a markdown link)
- 2-3 sentence explanation of *why* it's worth 30 minutes and *what you'll learn*

Stories:
${storyList}

Reply with only the 3 picks, formatted cleanly for Discord markdown.`;

  const result = await callGroq(prompt);
  await channel.send(`📚 **Friday Learning Picks — ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}**\n\n${result}`);

  // ── Topic updates ───────────────────────────────────────────────────────────
  const state = getState();
  const topics = ((state?.learningTopics ?? []) as LearningTopic[]);
  const activeTopics = topics.filter(t => t.trackWeekly);

  if (!activeTopics.length) return;

  await channel.send("🔍 **Topic Updates** — searching for what's new this week…");

  for (const topic of activeTopics) {
    const shownIds = await sendTopicDigest(channel, topic);
    if (shownIds.length) {
      // Keep at most 50 recent IDs to prevent unbounded growth
      topic.lastSeenIds = [...new Set([...topic.lastSeenIds, ...shownIds])].slice(-50);
    }
  }

  if (state) await saveState({ ...state, learningTopics: topics });
  await channel.send(buildTrackingPrompt(topics));
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
let _botStarted = false;

export function startDiscordBot() {
  if (_botStarted) {
    console.log("[Discord] Bot already started — skipping duplicate init.");
    return;
  }
  _botStarted = true;

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.log("[Discord] Missing BOT_TOKEN or CHANNEL_ID — skipping.");
    _botStarted = false;
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("clientReady", async () => {
    console.log(`[Discord] Bot ready as ${client.user?.tag}`);
    const initState = getState() as Record<string, unknown> | null;
    const settings = initState?.settings as Record<string, unknown> | undefined;

    type BotJob = { id: string; name: string; type: string; cron: string; enabled: boolean; projectFilter?: string | null; priorityFilter?: string };

    // Resolve job list: new jobs[] format, or migrate legacy digestCron/learnCron
    let botJobs: BotJob[];
    if (Array.isArray(settings?.jobs) && (settings!.jobs as unknown[]).length > 0) {
      botJobs = settings!.jobs as BotJob[];
    } else {
      botJobs = [
        { id: "job_digest", name: "Daily Digest",    type: "digest",   cron: (settings?.digestCron as string) ?? "0 10 * * 1-5", enabled: true, projectFilter: null, priorityFilter: "All" },
        { id: "job_learn",  name: "Friday Learning", type: "learning", cron: (settings?.learnCron  as string) ?? "0 8 * * 5",    enabled: true },
      ];
    }

    for (const job of botJobs) {
      if (!job.enabled) { console.log(`[Discord] Job "${job.name}" is disabled — skipping`); continue; }
      cron.schedule(job.cron, async () => {
        console.log(`[Discord] Firing job "${job.name}"...`);
        const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
        if (!channel) return;
        if (job.type === "digest") await sendDigest(channel, { projectFilter: job.projectFilter ?? null, priorityFilter: job.priorityFilter ?? "All" });
        else if (job.type === "learning") await sendFridayLearning(channel);
      });
      console.log(`[Discord] Scheduled "${job.name}" (${job.type}): ${job.cron}`);
    }
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (msg.channelId !== channelId) return;

    const content = msg.content.trim().toLowerCase();

    // !help
    if (content === "!help") {
      await msg.reply(
        "**📌 Hub Commands**\n" +
        "`!tasks` — list active tasks\n" +
        "`!digest` — AI-generated daily digest\n" +
        "`!summary` — workday focus summary\n" +
        "`!addtask <title>` — add a new task\n" +
        "`!done <task number>` — mark task as done\n" +
        "`!learn` — fetch Friday learning picks now\n" +
        "`!topics` — list tracked learning topics\n" +
        "`!addtopic <name>` — start tracking a topic\n" +
        "`!removetopic <n>` — remove a topic permanently\n" +
        "`!trackweekly <n>` — pause/resume weekly updates for a topic\n" +
        "`!help` — show this menu"
      );
    }

    // !tasks
    else if (content === "!tasks") {
      const state = getState();
      if (!state) { await msg.reply("⚠️ No data."); return; }
      const active = (state.tasks || []).filter((t: Record<string, unknown>) => !t.done).slice(0, 20);
      if (!active.length) { await msg.reply("✅ No active tasks — all clear!"); return; }
      const list = active
        .map((t: Record<string, unknown>, i: number) =>
          `${i + 1}. [${t.priority}] ${t.title}${t.eta ? ` — due ${t.eta}` : ""}`
        )
        .join("\n");
      await msg.reply(`**Active Tasks (${active.length})**\n\`\`\`\n${list}\n\`\`\``);
    }

    // !digest
    else if (content === "!digest") {
      await msg.reply("⏳ Generating digest...");
      await sendDigest(msg.channel as TextChannel);
    }

    // !summary
    else if (content === "!summary") {
      const state = getState();
      if (!state) { await msg.reply("⚠️ No data."); return; }
      const active = (state.tasks || []).filter((t: Record<string, unknown>) => !t.done);
      const prompt = `Productivity assistant. Give a concise workday focus summary under 120 words:\n${
        active.map((t: Record<string, unknown>) => `- [${t.priority}] ${t.title}`).join("\n") || "No tasks."
      }`;
      const thinking = await msg.reply("⏳ Thinking...");
      const summary = await callGroq(prompt);
      await thinking.edit(`🗓️ **Focus Summary**\n${summary}`);
    }

    // !addtask <title>
    else if (content.startsWith("!addtask ")) {
      const title = msg.content.trim().slice(9).trim();
      if (!title) { await msg.reply("Usage: `!addtask <title>`"); return; }
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const newTask = {
        id: Math.random().toString(36).slice(2, 9),
        title,
        priority: "Medium",
        category: "Other",
        done: false,
        createdAt: new Date().toISOString().slice(0, 10),
        projectId: state.projects?.[0]?.id ?? "p_memo",
        subtasks: [], notes: "", eta: "", tagProjectIds: [], deps: [], recur: null,
      };
      state.tasks = [newTask, ...(state.tasks || [])];
      await saveState(state);
      await msg.reply(`✅ Task added: **${title}**`);
    }

    // !done <number>
    else if (content.startsWith("!done ")) {
      const idx = parseInt(msg.content.trim().slice(6)) - 1;
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const active = (state.tasks || []).filter((t: Record<string, unknown>) => !t.done);
      if (isNaN(idx) || idx < 0 || idx >= active.length) {
        await msg.reply(`❌ Invalid number. Use \`!tasks\` to see the list.`);
        return;
      }
      const task = active[idx] as Record<string, unknown>;
      const taskInAll = state.tasks.find((t: Record<string, unknown>) => t.id === task.id);
      if (taskInAll) {
        taskInAll.done = true;
        taskInAll.doneAt = new Date().toISOString();
      }
      await saveState(state);
      await msg.reply(`✅ Marked done: **${task.title}**`);
    }

    // !learn
    else if (content === "!learn") {
      await sendFridayLearning(msg.channel as TextChannel);
    }

    // !topics
    else if (content === "!topics") {
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const topics = ((state.learningTopics ?? []) as LearningTopic[]);
      if (!topics.length) {
        await msg.reply("No topics tracked yet. Add one with `!addtopic <name>`.");
        return;
      }
      const list = topics
        .map((t, i) => `${i + 1}. **${t.name}** — ${t.trackWeekly ? "✅ weekly" : "⏸ paused"} (added ${t.addedAt})`)
        .join("\n");
      await msg.reply(`**📚 Learning Topics (${topics.length})**\n${list}`);
    }

    // !addtopic <name>
    else if (content.startsWith("!addtopic ")) {
      const name = msg.content.trim().slice(10).trim();
      if (!name) { await msg.reply("Usage: `!addtopic <topic name>`"); return; }
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const topics = ((state.learningTopics ?? []) as LearningTopic[]);
      if (topics.some(t => t.name.toLowerCase() === name.toLowerCase())) {
        await msg.reply(`⚠️ Already tracking **${name}**. Use \`!topics\` to see the list.`);
        return;
      }
      const newTopic: LearningTopic = {
        id: Math.random().toString(36).slice(2, 9),
        name,
        addedAt: new Date().toISOString().slice(0, 10),
        trackWeekly: true,
        lastSeenIds: [],
      };
      state.learningTopics = [newTopic, ...topics];
      await saveState(state);
      await msg.reply(`✅ Now tracking **${name}** — updates every Friday!`);
    }

    // !removetopic <n>
    else if (content.startsWith("!removetopic ")) {
      const idx = parseInt(msg.content.trim().slice(13)) - 1;
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const topics = ((state.learningTopics ?? []) as LearningTopic[]);
      if (isNaN(idx) || idx < 0 || idx >= topics.length) {
        await msg.reply(`❌ Invalid number. Use \`!topics\` to see the list.`);
        return;
      }
      const removed = topics[idx];
      state.learningTopics = topics.filter((_, i) => i !== idx);
      await saveState(state);
      await msg.reply(`🗑 Removed topic: **${removed.name}**`);
    }

    // !trackweekly <n>
    else if (content.startsWith("!trackweekly ")) {
      const idx = parseInt(msg.content.trim().slice(13)) - 1;
      const state = getState();
      if (!state) { await msg.reply("⚠️ Could not load state."); return; }
      const topics = ((state.learningTopics ?? []) as LearningTopic[]);
      if (isNaN(idx) || idx < 0 || idx >= topics.length) {
        await msg.reply(`❌ Invalid number. Use \`!topics\` to see the list.`);
        return;
      }
      topics[idx] = { ...topics[idx], trackWeekly: !topics[idx].trackWeekly };
      state.learningTopics = topics;
      await saveState(state);
      const status = topics[idx].trackWeekly ? "✅ weekly tracking ON" : "⏸ weekly tracking paused";
      await msg.reply(`${status}: **${topics[idx].name}**`);
    }

  });

  client.login(token).catch((err) => {
    console.error("[Discord] Login failed:", err.message);
  });

  return client;
}
