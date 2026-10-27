import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");

/** Opens (or creates) the SQLite database and brings its schema up to date. */
export function openDatabase(file: string): { db: Db; sqlite: Database.Database } {
  restrictToOwner(file);
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite };
}

/**
 * The database holds names, e-mail addresses, password hashes and signature
 * images: owner-only, whatever the umask. SQLite gives its -wal and -shm files
 * the mode of the main file, so the file is created (or tightened, for an
 * install made by an earlier version) before SQLite opens it.
 */
function restrictToOwner(file: string) {
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
