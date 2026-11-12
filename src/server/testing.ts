import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "pg";
import { parseConfig } from "./config";
import { MemoryMailer } from "./mail";
import { createServices, type Services } from "./services";

/** Every database the tests create starts with this, so that leftovers are recognisable. */
export const TEST_DATABASE_PREFIX = "signsen_test_";

/**
 * The PostgreSQL server the tests run on: `TEST_DATABASE_URL`, a connection to
 * any existing database (usually `postgres`) with a role allowed to create
 * databases. The tests never write to that database itself.
 */
export function testServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The tests need a PostgreSQL server where they can create and drop " +
        `their own "${TEST_DATABASE_PREFIX}*" databases, e.g. TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres ` +
        "(see CONTRIBUTING.md).",
    );
  }
  return url;
}

async function onServer<T>(run: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: testServerUrl() });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

/** Creates an empty database with a unique name and returns its connection string. */
export async function createTestDatabase(): Promise<{ name: string; url: string }> {
  // The run id comes from the global setup, which drops what a crashed run left behind.
  const name = `${TEST_DATABASE_PREFIX}${process.env.SIGNSEN_TEST_RUN ?? "manual"}_${randomBytes(6).toString("hex")}`;
  await onServer((admin) => admin.query(`create database "${name}"`));
  const url = new URL(testServerUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function dropTestDatabase(name: string): Promise<void> {
  if (!name.startsWith(TEST_DATABASE_PREFIX) || !/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to drop "${name}": not a test database`);
  await onServer((admin) => admin.query(`drop database if exists "${name}" with (force)`));
}

/**
 * Fresh, isolated services for one test: its own PostgreSQL database (migrated
 * like a real instance), temporary data dir, in-memory mail, manual clock.
 */
export async function makeTestServices(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signsen-test-"));
  const database = await createTestDatabase();
  const clock = { t: Date.UTC(2026, 0, 15, 9, 0, 0) };
  const mailer = new MemoryMailer();
  const config = parseConfig({
    DATA_DIR: dir,
    DATABASE_URL: database.url,
    APP_URL: "http://signsen.test",
    MAIL_TRANSPORT: "console",
    ...env,
  });
  let s: Services;
  try {
    s = await createServices(config, { mailer, now: () => clock.t });
  } catch (e) {
    await dropTestDatabase(database.name);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    s,
    mailer,
    clock,
    /** Connection string of this test's database, to open more connections to it. */
    databaseUrl: database.url,
    advance(ms: number) {
      clock.t += ms;
    },
    /**
     * Opens `connections` connections before a concurrency test. Without it the
     * first request would run alone, on the only open connection, while the
     * pool is still connecting the others — and the race would not be tested.
     */
    async warm(connections = 8) {
      await Promise.all(Array.from({ length: connections }, () => s.pool.query("select pg_sleep(0.05)")));
    },
    async cleanup() {
      await s.pool.end();
      await dropTestDatabase(database.name);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestKit = Awaited<ReturnType<typeof makeTestServices>>;

/** A small synthetic A4 PDF; the second page can be rotated by 90°. */
export async function samplePdf(opts: { pages?: number; rotateSecond?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 2); i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Contrat de prestation — page ${i + 1}`, { x: 60, y: 780, size: 14, font });
    if (i === 1 && opts.rotateSecond) page.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}
