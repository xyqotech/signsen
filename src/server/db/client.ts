import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

/** The connection pool, or an open transaction: anything that can run a query. */
export type Db = NodePgDatabase<typeof schema>;

/** An open transaction only. Asked for by code that relies on a lock held until commit. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");

// Arbitrary constant shared by every SignSen instance: "who migrates" mutex.
const MIGRATION_LOCK = 7_446_001;

/** Connects to PostgreSQL and brings the schema up to date. */
export async function openDatabase(url: string): Promise<{ db: Db; pool: Pool }> {
  // Fail a request after 10 s rather than let it hang when the server does not answer.
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", (e) => console.error(`[db] idle connection lost: ${e.message}`));
  try {
    await migrateDatabase(pool);
  } catch (e) {
    await pool.end();
    throw e;
  }
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Applies pending migrations on one connection, behind a session lock: several
 * instances (or bundles of one instance) starting together migrate one at a time.
 */
async function migrateDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}
