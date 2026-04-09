import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock fetch before importing the route ────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { GET, POST, OPTIONS } = await import("../app/api/claude/route");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeGroqOk(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
    }),
  };
}

function makeGroqError(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  };
}

function makeReq(body: unknown): Request {
  return new Request("http://x/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => mockFetch.mockReset());

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
describe("OPTIONS /api/claude", () => {
  it("returns 204 with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

// ─── POST — happy path ────────────────────────────────────────────────────────
describe("POST /api/claude — success", () => {
  it("returns content array in Anthropic shape", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("Hello world!"));
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    const data = await res.json();
    expect(data.content).toBeInstanceOf(Array);
    expect(data.content[0].text).toBe("Hello world!");
  });

  it("passes messages to Groq correctly", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Test" }] }) as never);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages).toContainEqual({ role: "user", content: "Test" });
  });

  it("prepends system message when system field is provided", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({
      messages: [{ role: "user", content: "Hello" }],
      system: "You are a helpful assistant",
    }) as never);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("does not prepend system message when system is absent", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages).toHaveLength(1);
  });

  it("uses default max_tokens when not provided", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(8096);
  });

  it("respects explicit max_tokens", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Hi" }], max_tokens: 500 }) as never);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(500);
  });

  it("targets the Groq completions endpoint", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["Authorization"]).toMatch(/^Bearer /);
  });

  it("returns CORS header on success", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqOk("ok"));
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ─── POST — error handling ────────────────────────────────────────────────────
describe("POST /api/claude — errors", () => {
  it("proxies Groq 401 error with message", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqError(401, "Invalid API key"));
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.message).toBe("Invalid API key");
  });

  it("proxies Groq 429 rate limit error", async () => {
    mockFetch.mockResolvedValueOnce(makeGroqError(429, "Rate limit exceeded"));
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    expect(res.status).toBe(429);
  });

  it("falls back to generic message when Groq error has no message", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.message).toBeTruthy();
  });

  it("returns empty text when Groq choices are empty", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [] }) });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "Hi" }] }) as never);
    const data = await res.json();
    expect(data.content[0].text).toBe("");
  });
});
