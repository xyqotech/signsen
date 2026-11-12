import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, GENESIS_HASH, listEvents, verifyChain, type EventInput } from "./audit";
import { parseConfig } from "./config";
import {
  canonicalJson,
  generateOtp,
  hashPassword,
  randomToken,
  safeEqualHex,
  sha256Hex,
  verifyPassword,
} from "./crypto";
import { MIGRATIONS_DIR, openDatabase, type Db } from "./db/client";
import { FileIntegrityError } from "./files";
import { MemoryMailer } from "./mail";
import { consumeRate } from "./ratelimit";
import { createServices } from "./services";
import { createTestDatabase, dropTestDatabase, makeTestServices, type TestKit } from "./testing";

const DATABASE_URL = "postgres://signsen:secret@localhost:5432/signsen";

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const c = parseConfig({ DATABASE_URL });
    expect(c.appUrl).toBe("http://localhost:3000");
    expect(c.brand.name).toBe("SignSen");
    expect(c.defaultLocale).toBe("fr");
    expect(c.allowSignup).toBe(true);
    expect(c.mail.transport).toBe("console");
    expect(c.databaseUrl).toBe(DATABASE_URL);
  });

  it("refuses to start without DATABASE_URL, and says so", () => {
    expect(() => parseConfig({})).toThrow(/Invalid configuration — DATABASE_URL: is required/);
    expect(() => parseConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL: is required/);
  });

  it("accepts only a PostgreSQL connection string, without echoing it", () => {
    expect(parseConfig({ DATABASE_URL: "postgresql://u:p@db/signsen" }).databaseUrl).toBe("postgresql://u:p@db/signsen");
    const refused = () => parseConfig({ DATABASE_URL: "file:./data/hunter2.db" });
    expect(refused).toThrow(/DATABASE_URL: must be a PostgreSQL connection string/);
    expect(refused).not.toThrow(/hunter2/);
  });

  it("normalises the URL and the brand colour", () => {
    const c = parseConfig({ DATABASE_URL, APP_URL: "https://sign.example.org///", BRAND_COLOR: "#AABBCC" });
    expect(c.appUrl).toBe("https://sign.example.org");
    expect(c.brand.color).toBe("#aabbcc");
  });

  it("lists every invalid variable", () => {
    expect(() => parseConfig({ DATABASE_URL, APP_URL: "not a url", BRAND_COLOR: "red" })).toThrow(/APP_URL.*BRAND_COLOR/);
  });

  it("requires SMTP_URL with the smtp transport", () => {
    expect(() => parseConfig({ DATABASE_URL, MAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_URL/);
  });

  it("requires the seal path and password together", () => {
    expect(() => parseConfig({ DATABASE_URL, SEAL_P12_PATH: "/x.p12" })).toThrow(/SEAL_P12/);
  });

  it("treats empty variables as unset", () => {
    expect(parseConfig({ DATABASE_URL, APP_NAME: "" }).brand.name).toBe("SignSen");
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords, rejecting wrong ones", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("salts each password hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("produces 6-digit codes that keep their leading zeros", () => {
    for (let i = 0; i < 500; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it("produces distinct 256-bit URL-safe tokens", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it("compares hex strings safely", () => {
    const h = sha256Hex("a");
    expect(safeEqualHex(h, sha256Hex("a"))).toBe(true);
    expect(safeEqualHex(h, sha256Hex("b"))).toBe(false);
    expect(safeEqualHex(h, h.slice(2))).toBe(false);
  });

  it("serialises JSON canonically", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });
});

/** Appends one event in its own transaction, as every caller does. */
const append = (db: Db, createdAt: number, input: EventInput) => db.transaction((tx) => appendEvent(tx, createdAt, input));

describe("audit trail", () => {
  let k: TestKit;
  beforeEach(async () => {
    k = await makeTestServices();
  });
  afterEach(() => k.cleanup());

  it("chains events per envelope from the genesis hash", async () => {
    const a = await append(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "owner:u1" });
    await append(k.s.db, 2, { envelopeId: "env-2", type: "envelope.created", actor: "owner:u2" });
    const b = await append(k.s.db, 3, {
      envelopeId: "env-1",
      type: "envelope.sent",
      actor: "owner:u1",
      ip: "203.0.113.7",
      userAgent: "Test/1.0",
      payload: { recipients: 2 },
    });
    const rows = await listEvents(k.s.db, "env-1");
    expect(rows.map((r) => r.type)).toEqual(["envelope.created", "envelope.sent"]);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(a.hash);
    expect(rows[1].hash).toBe(b.hash);
    expect(rows[1].payload).toEqual({ recipients: 2 });
    expect(await verifyChain(k.s.db, "env-1")).toEqual({ ok: true, count: 2, lastHash: b.hash });
  });

  it("refuses to update, delete or truncate events, at the database level", async () => {
    await append(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "system" });
    await expect(k.s.pool.query("update events set actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(k.s.pool.query("delete from events")).rejects.toThrow(/append-only/);
    await expect(k.s.pool.query("truncate events")).rejects.toThrow(/append-only/);
    await expect(k.s.pool.query("truncate events restart identity cascade")).rejects.toThrow(/append-only/);
    const rows = await listEvents(k.s.db, "env-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("system");
  });

  it("detects a forged event inserted into the chain", async () => {
    await append(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "system" });
    const [last] = await listEvents(k.s.db, "env-1");
    await k.s.pool.query(
      "insert into events (envelope_id, type, actor, payload, created_at, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7)",
      ["env-1", "recipient.signed", "recipient:r1", "{}", 2, last.hash, "f".repeat(64)],
    );
    expect(await verifyChain(k.s.db, "env-1")).toMatchObject({ ok: false });
  });

  it("keeps one chain when many writers append to the same envelope at once, over several connections", async () => {
    // A second pool on the same database: another instance of the application.
    const other = await openDatabase(k.databaseUrl);
    try {
      const writers = 40;
      await k.warm();
      await Promise.all(Array.from({ length: 8 }, () => other.pool.query("select pg_sleep(0.05)")));
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          append(i % 2 === 0 ? k.s.db : other.db, 1000 + i, {
            envelopeId: "env-busy",
            type: "envelope.updated",
            actor: `owner:u${i}`,
            payload: { i },
          }),
        ),
      );
      // Really concurrent: more than one server connection was in use.
      expect(k.s.pool.totalCount + other.pool.totalCount).toBeGreaterThan(2);

      const rows = await listEvents(k.s.db, "env-busy");
      expect(rows).toHaveLength(writers);
      expect(new Set(results.map((r) => r.hash)).size).toBe(writers);
      // No fork: every event has its own predecessor, and exactly one starts the chain.
      expect(new Set(rows.map((r) => r.prevHash)).size).toBe(writers);
      expect(rows.filter((r) => r.prevHash === GENESIS_HASH)).toHaveLength(1);
      expect(await verifyChain(k.s.db, "env-busy")).toMatchObject({ ok: true, count: writers });
      // Other envelopes are not held up by that lock, nor mixed into the chain.
      await append(other.db, 5000, { envelopeId: "env-quiet", type: "envelope.created", actor: "system" });
      expect(await verifyChain(k.s.db, "env-quiet")).toMatchObject({ ok: true, count: 1 });
    } finally {
      await other.pool.end();
    }
  });

  it("refuses a second successor of the same event, at the database level", async () => {
    await append(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "system" });
    await append(k.s.db, 2, { envelopeId: "env-1", type: "envelope.sent", actor: "system" });
    const [first] = await listEvents(k.s.db, "env-1");
    const fork = (envelopeId: string, prevHash: string) =>
      k.s.pool.query(
        "insert into events (envelope_id, type, actor, payload, created_at, prev_hash, hash) values ($1, 'envelope.cancelled', 'system', '{}', 3, $2, $3)",
        [envelopeId, prevHash, "e".repeat(64)],
      );
    await expect(fork("env-1", first.hash)).rejects.toThrow(/events_chain_unique/);
    await expect(fork("env-1", GENESIS_HASH)).rejects.toThrow(/events_chain_unique/);
    // The same predecessor hash under another envelope is another chain.
    await expect(fork("env-2", GENESIS_HASH)).resolves.toBeDefined();
    expect(await listEvents(k.s.db, "env-1")).toHaveLength(2);
  });
});

describe("database start-up", () => {
  let database: { name: string; url: string };
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(() => dropTestDatabase(database.name));

  it("migrates an empty database once when several instances start together", async () => {
    const instances = await Promise.all(Array.from({ length: 6 }, () => openDatabase(database.url)));
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
      const { rows } = await instances[0].pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
      expect(rows[0].n).toBe(journal.entries.length);
      // Every instance works on the migrated schema.
      const counts = await Promise.all(instances.map((i) => i.pool.query("select count(*)::int as n from events")));
      expect(counts.map((c) => c.rows[0].n)).toEqual(Array(6).fill(0));
    } finally {
      await Promise.all(instances.map((i) => i.pool.end()));
    }
  });

  it("fails when the server cannot be reached, instead of starting without a database", async () => {
    await expect(openDatabase("postgres://signsen:secret@127.0.0.1:1/signsen")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("file store", () => {
  let k: TestKit;
  beforeEach(async () => {
    k = await makeTestServices();
  });
  afterEach(() => k.cleanup());

  it("stores content once, addressed by its sha256", async () => {
    const bytes = Buffer.from("%PDF-1.7 hello");
    const id = await k.s.files.put(bytes, "application/pdf");
    expect(id).toBe(sha256Hex(bytes));
    expect(await k.s.files.put(bytes, "application/pdf")).toBe(id);
    expect(k.s.files.get(id).equals(bytes)).toBe(true);
  });

  it("refuses a file altered on disk", async () => {
    const id = await k.s.files.put(Buffer.from("original"), "text/plain");
    fs.writeFileSync(path.join(k.s.config.dataDir, "files", id.slice(0, 2), id), "tampered");
    expect(() => k.s.files.get(id)).toThrow(FileIntegrityError);
  });

  it("rejects ids that are not sha256 hex (no path traversal)", () => {
    expect(() => k.s.files.get("../../etc/passwd")).toThrow(/Invalid file id/);
  });
});

describe("rate limiter", () => {
  let k: TestKit;
  beforeEach(async () => {
    k = await makeTestServices();
  });
  afterEach(() => k.cleanup());

  it("allows up to the limit within a window, then reopens", async () => {
    const hit = (t: number) => consumeRate(k.s.db, "otp:r1", 3, 60_000, t);
    expect([await hit(0), await hit(1), await hit(2), await hit(3)]).toEqual([true, true, true, false]);
    expect(await hit(59_999)).toBe(false);
    expect(await hit(60_000)).toBe(true);
    expect([await hit(60_001), await hit(60_002), await hit(60_003)]).toEqual([true, true, false]);
  });

  it("counts keys independently", async () => {
    expect(await consumeRate(k.s.db, "a", 1, 1000, 0)).toBe(true);
    expect(await consumeRate(k.s.db, "a", 1, 1000, 1)).toBe(false);
    expect(await consumeRate(k.s.db, "b", 1, 1000, 1)).toBe(true);
  });

  it("never lets concurrent requests exceed the limit", async () => {
    await k.warm();
    const answers = await Promise.all(Array.from({ length: 30 }, () => consumeRate(k.s.db, "signin:ip:198.51.100.7", 5, 60_000, 1000)));
    expect(answers.filter(Boolean)).toHaveLength(5);
    expect(k.s.pool.totalCount).toBeGreaterThan(1);
  });
});

describe("instance secrets", () => {
  let k: TestKit;
  beforeEach(async () => {
    k = await makeTestServices({ APP_NAME: "Acme" });
  });
  afterEach(() => k.cleanup());

  it("creates a 32-byte instance key readable only by its owner", () => {
    const file = path.join(k.s.config.dataDir, "instance.key");
    expect(k.s.secret).toHaveLength(32);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("generates a self-signed seal once and reuses it", () => {
    const seal = k.s.sealIdentity();
    expect(seal.selfSigned).toBe(true);
    expect(seal.subject).toContain("CN=Acme document seal");
    expect(seal.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fs.statSync(path.join(k.s.config.dataDir, "seal", "seal.p12")).mode & 0o077).toBe(0);
    expect(k.s.sealIdentity().fingerprint).toBe(seal.fingerprint);
  });
});

describe.skipIf(process.platform === "win32")("data directory permissions", () => {
  const dirs: string[] = [];
  let database: { name: string; url: string };
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await dropTestDatabase(database.name);
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const privateMode = (file: string) => fs.statSync(file).mode & 0o077;
  const open = (dir: string) =>
    createServices(parseConfig({ DATA_DIR: dir, DATABASE_URL: database.url, MAIL_TRANSPORT: "console" }), { mailer: new MemoryMailer() });

  it("creates the data folders and the stored files readable only by their owner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signsen-perm-"));
    dirs.push(dir);
    fs.chmodSync(dir, 0o755); // as an operator would create it, before the first start
    const s = await open(dir);
    try {
      const id = await s.files.put(Buffer.from("%PDF-1.7 x"), "application/pdf");
      expect(privateMode(dir)).toBe(0);
      expect(privateMode(path.join(dir, "files"))).toBe(0);
      expect(privateMode(path.join(dir, "files", id.slice(0, 2)))).toBe(0);
      expect(privateMode(path.join(dir, "files", id.slice(0, 2), id))).toBe(0);
      expect(privateMode(path.join(dir, "instance.key"))).toBe(0);
      // Records live in PostgreSQL: no database file is left in the data directory.
      expect(fs.readdirSync(dir).sort()).toEqual(["files", "instance.key"]);
    } finally {
      await s.pool.end();
    }
  });

  it("tightens data folders left readable by others by an earlier start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signsen-perm-"));
    dirs.push(dir);
    await (await open(dir)).pool.end();
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(path.join(dir, "files"), 0o755);
    const s = await open(dir);
    try {
      expect(privateMode(dir)).toBe(0);
      expect(privateMode(path.join(dir, "files"))).toBe(0);
    } finally {
      await s.pool.end();
    }
  });
});
