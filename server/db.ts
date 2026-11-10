import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * Ordered schema migrations. `PRAGMA user_version` records how many have run;
 * append new steps, never edit shipped ones.
 */
const MIGRATIONS: Array<(db: Database) => void> = [
  // 1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        -- ImageRecord JSON (no binaries)
        record TEXT NOT NULL,
        original_file TEXT NOT NULL,
        original_mime TEXT NOT NULL,
        thumbnail_file TEXT NOT NULL,
        thumbnail_mime TEXT NOT NULL
      );
      CREATE INDEX images_by_created_at ON images (created_at DESC, id DESC);

      CREATE TABLE "references" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file TEXT NOT NULL,
        source_gallery_item_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_gallery_item_id TEXT,
        -- StoredEditorSession JSON
        data TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_by_gallery_item ON sessions (source_gallery_item_id, id);

      -- Persisted client settings (zustand persist JSON), keyed by store name.
      CREATE TABLE settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Best-effort string cache backing Platform.cache.
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Reserved for server-side generation jobs (M4).
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        task TEXT,
        item_ids TEXT,
        status TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        error TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        item TEXT,
        updated_at INTEGER
      );
      CREATE INDEX items_by_job ON items (job_id);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this server supports (${MIGRATIONS.length}).`
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Open (creating if needed) the database, enable WAL, and run pending migrations. */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Run `fn` inside a transaction (synchronous; node:sqlite has no async API). */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
