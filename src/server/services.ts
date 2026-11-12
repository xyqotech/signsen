import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { parseConfig, type AppConfig } from "./config";
import { openDatabase, type Db } from "./db/client";
import { createFileStore, privateDir, type FileStore } from "./files";
import { createMailer, type Mailer } from "./mail";
import { loadSealIdentity, type SealIdentity } from "./pdf/seal-identity";

export interface Services {
  config: AppConfig;
  db: Db;
  /** The connection pool behind `db`; closed with `pool.end()` when the services are discarded. */
  pool: Pool;
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

/** Prepares the data directory, connects to PostgreSQL and applies pending migrations. */
export async function createServices(config: AppConfig, overrides: ServiceOverrides = {}): Promise<Services> {
  privateDir(config.dataDir);
  const now = overrides.now ?? (() => Date.now());
  const secret = loadOrCreateSecret(path.join(config.dataDir, "instance.key"));
  const { db, pool } = await openDatabase(config.databaseUrl);
  let seal: SealIdentity | undefined;
  try {
    return {
      config,
      db,
      pool,
      files: createFileStore(db, path.join(config.dataDir, "files"), now),
      mailer: overrides.mailer ?? createMailer(config),
      now,
      secret,
      sealIdentity: () => (seal ??= loadSealIdentity(config)),
    };
  } catch (e) {
    await pool.end(); // a start-up that fails is retried: do not leave its connections behind
    throw e;
  }
}

function loadOrCreateSecret(file: string): Buffer {
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32), { mode: 0o600 });
  const secret = fs.readFileSync(file);
  if (secret.length !== 32) throw new Error(`${file} is corrupted (expected 32 bytes)`);
  return secret;
}

const globalForServices = globalThis as unknown as { __signsenServices?: Promise<Services> };

/**
 * Process-wide services built from process.env (one connection pool). The
 * promise is shared, so requests arriving together wait for the same start-up;
 * a failed start-up (database unreachable, bad configuration) is not kept, and
 * the next request tries again.
 */
export function getServices(): Promise<Services> {
  return (globalForServices.__signsenServices ??= start().catch((e: unknown) => {
    globalForServices.__signsenServices = undefined;
    throw e;
  }));
}

async function start(): Promise<Services> {
  return createServices(parseConfig(process.env));
}
