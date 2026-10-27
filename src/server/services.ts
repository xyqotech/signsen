import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { parseConfig, type AppConfig } from "./config";
import { openDatabase, type Db } from "./db/client";
import { createFileStore, type FileStore } from "./files";
import { createMailer, type Mailer } from "./mail";
import { loadSealIdentity, type SealIdentity } from "./pdf/seal-identity";

export interface Services {
  config: AppConfig;
  db: Db;
  sqlite: Database.Database;
  files: FileStore;
  mailer: Mailer;
  now: () => number;
  /** Per-instance secret (HMAC of one-time codes). */
  secret: Buffer;
  /** Loaded on first use: key generation takes a moment. */
  sealIdentity: () => SealIdentity;
}

export interface ServiceOverrides {
  mailer?: Mailer;
  now?: () => number;
}

export function createServices(config: AppConfig, overrides: ServiceOverrides = {}): Services {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const now = overrides.now ?? (() => Date.now());
  const { db, sqlite } = openDatabase(path.join(config.dataDir, "signsen.db"));
  let seal: SealIdentity | undefined;
  return {
    config,
    db,
    sqlite,
    files: createFileStore(db, path.join(config.dataDir, "files"), now),
    mailer: overrides.mailer ?? createMailer(config),
    now,
    secret: loadOrCreateSecret(path.join(config.dataDir, "instance.key")),
    sealIdentity: () => (seal ??= loadSealIdentity(config)),
  };
}

function loadOrCreateSecret(file: string): Buffer {
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32), { mode: 0o600 });
  const secret = fs.readFileSync(file);
  if (secret.length !== 32) throw new Error(`${file} is corrupted (expected 32 bytes)`);
  return secret;
}

const globalForServices = globalThis as unknown as { __signsenServices?: Services };

/** Process-wide services built from process.env (one database connection). */
export function getServices(): Services {
  return (globalForServices.__signsenServices ??= createServices(parseConfig(process.env)));
}
