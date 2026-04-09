import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { db, BACKUP_PATH } from "@/lib/db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function writeBackup() {
  try {
    const rows = db.prepare("SELECT key, value FROM store").all() as { key: string; value: string }[];
    const snapshot: Record<string, unknown> = {};
    for (const row of rows) {
      try { snapshot[row.key] = JSON.parse(row.value); } catch { snapshot[row.key] = row.value; }
    }
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(snapshot, null, 2));
  } catch {}
}

// GET /api/storage?key=xxx  → { value }
// GET /api/storage?prefix=xxx  → { keys: [...] }
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key    = searchParams.get("key");
  const prefix = searchParams.get("prefix");

  if (key) {
    const row = db.prepare("SELECT value FROM store WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return NextResponse.json({ value: null }, { headers: CORS_HEADERS });
    return NextResponse.json({ value: row.value }, { headers: CORS_HEADERS });
  }

  if (prefix !== null) {
    const rows = db.prepare("SELECT key FROM store WHERE key LIKE ?").all(`${prefix}%`) as { key: string }[];
    return NextResponse.json({ keys: rows.map(r => r.key) }, { headers: CORS_HEADERS });
  }

  return NextResponse.json({ error: "Provide ?key= or ?prefix=" }, { status: 400, headers: CORS_HEADERS });
}

// POST /api/storage  { key, value }  → { ok: true }
export async function POST(req: NextRequest) {
  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400, headers: CORS_HEADERS });

  db.prepare(
    "INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  ).run(key, value, new Date().toISOString());

  writeBackup();
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

// DELETE /api/storage?key=xxx  → { ok: true }
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400, headers: CORS_HEADERS });

  db.prepare("DELETE FROM store WHERE key = ?").run(key);
  writeBackup();
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}
