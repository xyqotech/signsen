import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { TEST_DATABASE_PREFIX, testServerUrl } from "./src/server/testing";

/**
 * Runs once around the whole test run: checks the PostgreSQL server is usable
 * before any test starts, and removes the databases a crashed test left behind.
 */
export default async function setup() {
  const run = randomBytes(4).toString("hex");
  // Inherited by the test workers, which name their databases after it.
  process.env.SIGNSEN_TEST_RUN = run;

  try {
    await onServer(async (admin) => {
      const { rows } = await admin.query("select rolcreatedb or rolsuper as ok from pg_roles where rolname = current_user");
      if (!rows[0]?.ok) throw new Error("The role of TEST_DATABASE_URL must be allowed to create databases (CREATEDB).");
    });
  } catch (e) {
    throw plain(e);
  }

  return async function teardown() {
    await onServer(async (admin) => {
      const { rows } = await admin.query("select datname from pg_database where datname like $1", [`${TEST_DATABASE_PREFIX}${run}\\_%`]);
      for (const { datname } of rows as { datname: string }[]) {
        await admin.query(`drop database if exists "${datname}" with (force)`);
      }
    });
  };
}

async function onServer(run: (admin: Client) => Promise<void>) {
  const admin = new Client({ connectionString: testServerUrl() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`Cannot reach the PostgreSQL server of TEST_DATABASE_URL: ${(e as Error).message || String(e)}`);
  }
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

/**
 * The message alone, as the stack: what the developer must read is the
 * instruction, and Vitest's reporter fails to print start-up errors whose
 * stack it has to map back to sources.
 */
function plain(e: unknown): Error {
  const error = e instanceof Error ? e : new Error(String(e));
  error.stack = `${error.name}: ${error.message}`;
  return error;
}
