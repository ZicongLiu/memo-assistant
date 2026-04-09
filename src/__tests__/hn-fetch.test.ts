import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock discord.js & node-cron to prevent bot startup side-effects ──────────
vi.mock("discord.js", () => ({
  Client: vi.fn(function () { return { once: vi.fn(), on: vi.fn(), login: vi.fn() }; }),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768 },
  TextChannel: class {},
}));
vi.mock("node-cron", () => ({ default: { schedule: vi.fn() }, schedule: vi.fn() }));
vi.mock("better-sqlite3", () => ({ default: vi.fn() }));
vi.mock("fs", () => ({ default: { existsSync: vi.fn().mockReturnValue(false) }, existsSync: vi.fn().mockReturnValue(false) }));

// ─── Global fetch mock ────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchHNStories, fetchHNAlgolia } = await import("../lib/discord-bot");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function storyItem(overrides: Partial<{ id: number; type: string; title: string; url: string; score: number }> = {}) {
  return {
    id:    overrides.id    ?? 1,
    type:  overrides.type  ?? "story",
    title: overrides.title ?? "Test Story",
    url:   overrides.url   ?? "https://example.com",
    score: overrides.score ?? 100,
  };
}

function mockTopStories(ids: number[]) {
  mockFetch.mockResolvedValueOnce({ json: async () => ids });
}

function mockItem(item: ReturnType<typeof storyItem>) {
  mockFetch.mockResolvedValueOnce({ json: async () => item });
}

beforeEach(() => mockFetch.mockReset());

// ─── Happy path ───────────────────────────────────────────────────────────────
describe("fetchHNStories — happy path", () => {
  it("returns stories from HN", async () => {
    mockTopStories([1, 2]);
    mockItem(storyItem({ id: 1, title: "AI Breakthrough", url: "https://ai.com", score: 500 }));
    mockItem(storyItem({ id: 2, title: "Rust 2.0",        url: "https://rust.org",score: 300 }));

    const stories = await fetchHNStories();
    expect(stories).toHaveLength(2);
    expect(stories[0]).toEqual({ title: "AI Breakthrough", url: "https://ai.com", score: 500 });
    expect(stories[1]).toEqual({ title: "Rust 2.0",        url: "https://rust.org",score: 300 });
  });

  it("calls the HN topstories endpoint", async () => {
    mockTopStories([1]);
    mockItem(storyItem());

    await fetchHNStories();
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
    );
  });

  it("calls the item endpoint for each ID", async () => {
    mockTopStories([42, 99]);
    mockItem(storyItem({ id: 42 }));
    mockItem(storyItem({ id: 99 }));

    await fetchHNStories();
    const itemUrls = mockFetch.mock.calls.slice(1).map(c => c[0] as string);
    expect(itemUrls).toContain("https://hacker-news.firebaseio.com/v0/item/42.json");
    expect(itemUrls).toContain("https://hacker-news.firebaseio.com/v0/item/99.json");
  });

  it("only fetches the first 40 IDs", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    mockTopStories(ids);
    // Provide 40 story items
    for (let i = 0; i < 40; i++) mockItem(storyItem({ id: i + 1 }));

    await fetchHNStories();
    // 1 topstories call + 40 item calls
    expect(mockFetch).toHaveBeenCalledTimes(41);
  });
});

// ─── Filtering ────────────────────────────────────────────────────────────────
describe("fetchHNStories — filtering", () => {
  it("excludes non-story types (jobs, ask, etc.)", async () => {
    mockTopStories([1, 2, 3]);
    mockItem(storyItem({ id: 1, type: "job",   title: "Hiring React devs" }));
    mockItem(storyItem({ id: 2, type: "ask",   title: "Ask HN: best tools?" }));
    mockItem(storyItem({ id: 3, type: "story", title: "Real story" }));

    const stories = await fetchHNStories();
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe("Real story");
  });

  it("excludes items with no URL", async () => {
    mockTopStories([1, 2]);
    mockFetch.mockResolvedValueOnce({ json: async () => ({ id: 1, type: "story", title: "No URL", score: 10 }) });
    mockItem(storyItem({ id: 2, title: "Has URL" }));

    const stories = await fetchHNStories();
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe("Has URL");
  });

  it("excludes items with no title", async () => {
    mockTopStories([1, 2]);
    mockFetch.mockResolvedValueOnce({ json: async () => ({ id: 1, type: "story", url: "https://a.com", score: 10 }) });
    mockItem(storyItem({ id: 2, title: "Has title" }));

    const stories = await fetchHNStories();
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe("Has title");
  });

  it("returns only title, url, and score fields", async () => {
    mockTopStories([1]);
    mockItem(storyItem({ id: 1, title: "Clean story", url: "https://clean.com", score: 42 }));

    const stories = await fetchHNStories();
    expect(Object.keys(stories[0])).toEqual(["title", "url", "score"]);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────
describe("fetchHNStories — error handling", () => {
  it("returns [] when the topstories fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const stories = await fetchHNStories();
    expect(stories).toEqual([]);
  });

  it("skips items whose individual fetch rejects", async () => {
    mockTopStories([1, 2]);
    mockFetch.mockRejectedValueOnce(new Error("item fetch failed")); // item 1 fails
    mockItem(storyItem({ id: 2, title: "Survivor" }));              // item 2 succeeds

    const stories = await fetchHNStories();
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe("Survivor");
  });

  it("returns [] when topstories endpoint returns empty list", async () => {
    mockTopStories([]);
    const stories = await fetchHNStories();
    expect(stories).toEqual([]);
  });
});

// ─── fetchHNAlgolia ──────────────────────────────────────────────────────────
function algoliaResponse(hits: Partial<{ objectID: string; title: string; url: string; points: number }>[]) {
  return { json: async () => ({ hits }) };
}

describe("fetchHNAlgolia — happy path", () => {
  it("queries the Algolia HN search endpoint", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([]));
    await fetchHNAlgolia("Rust");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("hn.algolia.com");
    expect(url).toContain("query=Rust");
  });

  it("restricts to last_7days", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([]));
    await fetchHNAlgolia("Rust");
    expect(mockFetch.mock.calls[0][0] as string).toContain("last_7days");
  });

  it("returns mapped hits with objectID, title, url, points", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "42", title: "Rust 2024", url: "https://rust.org", points: 300 },
    ]));
    const results = await fetchHNAlgolia("Rust");
    expect(results).toEqual([{ objectID: "42", title: "Rust 2024", url: "https://rust.org", points: 300 }]);
  });

  it("falls back to HN item permalink when url is absent", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "99", title: "Ask HN: Rust tips" },
    ]));
    const results = await fetchHNAlgolia("Rust");
    expect(results[0].url).toBe("https://news.ycombinator.com/item?id=99");
  });

  it("defaults points to 0 when absent", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "7", title: "Rust news" },
    ]));
    const results = await fetchHNAlgolia("Rust");
    expect(results[0].points).toBe(0);
  });
});

describe("fetchHNAlgolia — deduplication", () => {
  it("excludes hits whose objectID is in excludeIds", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "old", title: "Old story", url: "https://a.com", points: 10 },
      { objectID: "new", title: "New story", url: "https://b.com", points: 20 },
    ]));
    const results = await fetchHNAlgolia("Rust", ["old"]);
    expect(results).toHaveLength(1);
    expect(results[0].objectID).toBe("new");
  });

  it("returns empty array when all hits are excluded", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "x", title: "Story", url: "https://a.com", points: 5 },
    ]));
    const results = await fetchHNAlgolia("Rust", ["x"]);
    expect(results).toEqual([]);
  });

  it("returns all hits when excludeIds is empty", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "a", title: "Story A", url: "https://a.com", points: 1 },
      { objectID: "b", title: "Story B", url: "https://b.com", points: 2 },
    ]));
    const results = await fetchHNAlgolia("Rust", []);
    expect(results).toHaveLength(2);
  });
});

describe("fetchHNAlgolia — error handling", () => {
  it("returns [] when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    expect(await fetchHNAlgolia("Rust")).toEqual([]);
  });

  it("returns [] when hits array is empty", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([]));
    expect(await fetchHNAlgolia("Rust")).toEqual([]);
  });

  it("filters out hits with no title", async () => {
    mockFetch.mockResolvedValueOnce(algoliaResponse([
      { objectID: "1", url: "https://a.com", points: 5 },
      { objectID: "2", title: "Has title", url: "https://b.com", points: 3 },
    ]));
    const results = await fetchHNAlgolia("Rust");
    expect(results).toHaveLength(1);
    expect(results[0].objectID).toBe("2");
  });
});
