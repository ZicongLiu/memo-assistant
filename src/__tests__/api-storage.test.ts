import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

// ─── In-memory DB mock ────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
const memDb  = new Database(":memory:");
memDb.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

vi.mock("@/lib/db", () => ({
  db:          memDb,
  BACKUP_PATH: path.join(tmpDir, "backup.json"),
  DATA_DIR:    tmpDir,
  DB_PATH:     path.join(tmpDir, "hub.db"),
}));

// Import handlers AFTER mock is in place
const { GET, POST, DELETE, OPTIONS } = await import("../app/api/storage/route");

// ─── Helper to build NextRequest ─────────────────────────────────────────────
function makeReq(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Clean DB between tests ───────────────────────────────────────────────────
function clearDb() { memDb.exec("DELETE FROM store"); }

afterAll(() => {
  memDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
describe("OPTIONS /api/storage", () => {
  it("returns 204 with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

// ─── GET ─────────────────────────────────────────────────────────────────────
describe("GET /api/storage", () => {
  beforeAll(clearDb);

  it("returns null for missing key", async () => {
    const res = await GET(makeReq("GET", "http://x/api/storage?key=missing") as never);
    const data = await res.json();
    expect(data.value).toBeNull();
  });

  it("returns stored value after POST", async () => {
    await POST(makeReq("POST", "http://x/api/storage", { key: "test_key", value: '{"hello":"world"}' }) as never);
    const res = await GET(makeReq("GET", "http://x/api/storage?key=test_key") as never);
    const data = await res.json();
    expect(data.value).toBe('{"hello":"world"}');
  });

  it("returns 400 when no key or prefix provided", async () => {
    const res = await GET(makeReq("GET", "http://x/api/storage") as never);
    expect(res.status).toBe(400);
  });

  it("lists keys matching prefix", async () => {
    clearDb();
    await POST(makeReq("POST", "http://x/api/storage", { key: "ns:a", value: "1" }) as never);
    await POST(makeReq("POST", "http://x/api/storage", { key: "ns:b", value: "2" }) as never);
    await POST(makeReq("POST", "http://x/api/storage", { key: "other:c", value: "3" }) as never);

    const res = await GET(makeReq("GET", "http://x/api/storage?prefix=ns:") as never);
    const data = await res.json();
    expect(data.keys).toHaveLength(2);
    expect(data.keys).toContain("ns:a");
    expect(data.keys).toContain("ns:b");
    expect(data.keys).not.toContain("other:c");
  });

  it("returns CORS header on success", async () => {
    const res = await GET(makeReq("GET", "http://x/api/storage?key=any") as never);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ─── POST ────────────────────────────────────────────────────────────────────
describe("POST /api/storage", () => {
  beforeAll(clearDb);

  it("stores a new value and returns ok:true", async () => {
    const res = await POST(makeReq("POST", "http://x/api/storage", { key: "mykey", value: "myval" }) as never);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("overwrites an existing key", async () => {
    await POST(makeReq("POST", "http://x/api/storage", { key: "ow", value: "first" }) as never);
    await POST(makeReq("POST", "http://x/api/storage", { key: "ow", value: "second" }) as never);
    const res = await GET(makeReq("GET", "http://x/api/storage?key=ow") as never);
    const data = await res.json();
    expect(data.value).toBe("second");
  });

  it("returns 400 when key is missing", async () => {
    const res = await POST(makeReq("POST", "http://x/api/storage", { value: "no-key" }) as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });

  it("writes a backup.json file after store", async () => {
    const backupPath = path.join(tmpDir, "backup.json");
    await POST(makeReq("POST", "http://x/api/storage", { key: "backup_test", value: '"hi"' }) as never);
    expect(fs.existsSync(backupPath)).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    expect(snapshot["backup_test"]).toBe("hi");
  });

  it("backup contains valid JSON for JSON values", async () => {
    const backupPath = path.join(tmpDir, "backup.json");
    await POST(makeReq("POST", "http://x/api/storage", { key: "json_val", value: '{"a":1}' }) as never);
    const snapshot = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    expect(snapshot["json_val"]).toEqual({ a: 1 });
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────
describe("DELETE /api/storage", () => {
  beforeAll(clearDb);

  it("deletes an existing key", async () => {
    await POST(makeReq("POST", "http://x/api/storage", { key: "del_me", value: "v" }) as never);
    const del = await DELETE(makeReq("DELETE", "http://x/api/storage?key=del_me") as never);
    expect((await del.json()).ok).toBe(true);

    const get = await GET(makeReq("GET", "http://x/api/storage?key=del_me") as never);
    expect((await get.json()).value).toBeNull();
  });

  it("returns ok:true even for non-existent key (idempotent)", async () => {
    const res = await DELETE(makeReq("DELETE", "http://x/api/storage?key=ghost") as never);
    expect((await res.json()).ok).toBe(true);
  });

  it("returns 400 when key is missing from query", async () => {
    const res = await DELETE(makeReq("DELETE", "http://x/api/storage") as never);
    expect(res.status).toBe(400);
  });
});

// ─── Full roundtrip ───────────────────────────────────────────────────────────
describe("Storage roundtrip", () => {
  it("POST → GET → DELETE → GET returns null", async () => {
    const key   = "roundtrip_key";
    const value = JSON.stringify({ tasks: [{ id: "1", title: "Test task" }] });

    await POST(makeReq("POST", "http://x/api/storage", { key, value }) as never);
    const get1 = await GET(makeReq("GET", `http://x/api/storage?key=${key}`) as never);
    expect((await get1.json()).value).toBe(value);

    await DELETE(makeReq("DELETE", `http://x/api/storage?key=${key}`) as never);
    const get2 = await GET(makeReq("GET", `http://x/api/storage?key=${key}`) as never);
    expect((await get2.json()).value).toBeNull();
  });
});
