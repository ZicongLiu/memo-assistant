import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export const DATA_DIR = process.env.TEST_DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "hub.db");
export const BACKUP_PATH = path.join(DATA_DIR, "backup.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
