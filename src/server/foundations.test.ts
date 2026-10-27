import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, GENESIS_HASH, listEvents, verifyChain } from "./audit";
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
import { FileIntegrityError } from "./files";
import { consumeRate } from "./ratelimit";
import { makeTestServices, type TestKit } from "./testing";

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const c = parseConfig({});
    expect(c.appUrl).toBe("http://localhost:3000");
    expect(c.brand.name).toBe("SignSen");
    expect(c.defaultLocale).toBe("fr");
    expect(c.allowSignup).toBe(true);
    expect(c.mail.transport).toBe("console");
  });

  it("normalises the URL and the brand colour", () => {
    const c = parseConfig({ APP_URL: "https://sign.example.org///", BRAND_COLOR: "#AABBCC" });
    expect(c.appUrl).toBe("https://sign.example.org");
    expect(c.brand.color).toBe("#aabbcc");
  });

  it("lists every invalid variable", () => {
    expect(() => parseConfig({ APP_URL: "not a url", BRAND_COLOR: "red" })).toThrow(/APP_URL.*BRAND_COLOR/);
  });

  it("requires SMTP_URL with the smtp transport", () => {
    expect(() => parseConfig({ MAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_URL/);
  });

  it("requires the seal path and password together", () => {
    expect(() => parseConfig({ SEAL_P12_PATH: "/x.p12" })).toThrow(/SEAL_P12/);
  });

  it("treats empty variables as unset", () => {
    expect(parseConfig({ APP_NAME: "" }).brand.name).toBe("SignSen");
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

describe("audit trail", () => {
  let k: TestKit;
  beforeEach(() => (k = makeTestServices()));
  afterEach(() => k.cleanup());

  it("chains events per envelope from the genesis hash", () => {
    const a = appendEvent(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "owner:u1" });
    appendEvent(k.s.db, 2, { envelopeId: "env-2", type: "envelope.created", actor: "owner:u2" });
    const b = appendEvent(k.s.db, 3, {
      envelopeId: "env-1",
      type: "envelope.sent",
      actor: "owner:u1",
      ip: "203.0.113.7",
      userAgent: "Test/1.0",
      payload: { recipients: 2 },
    });
    const rows = listEvents(k.s.db, "env-1");
    expect(rows.map((r) => r.type)).toEqual(["envelope.created", "envelope.sent"]);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(a.hash);
    expect(rows[1].hash).toBe(b.hash);
    expect(rows[1].payload).toEqual({ recipients: 2 });
    expect(verifyChain(k.s.db, "env-1")).toEqual({ ok: true, count: 2, lastHash: b.hash });
  });

  it("refuses to update or delete an event, at the database level", () => {
    appendEvent(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "system" });
    expect(() => k.s.sqlite.prepare("update events set actor = 'x'").run()).toThrow(/append-only/);
    expect(() => k.s.sqlite.prepare("delete from events").run()).toThrow(/append-only/);
  });

  it("detects a forged event inserted into the chain", () => {
    appendEvent(k.s.db, 1, { envelopeId: "env-1", type: "envelope.created", actor: "system" });
    const last = listEvents(k.s.db, "env-1")[0];
    k.s.sqlite
      .prepare(
        "insert into events (envelope_id, type, actor, payload, created_at, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("env-1", "recipient.signed", "recipient:r1", "{}", 2, last.hash, "f".repeat(64));
    expect(verifyChain(k.s.db, "env-1")).toMatchObject({ ok: false });
  });
});

describe("file store", () => {
  let k: TestKit;
  beforeEach(() => (k = makeTestServices()));
  afterEach(() => k.cleanup());

  it("stores content once, addressed by its sha256", () => {
    const bytes = Buffer.from("%PDF-1.7 hello");
    const id = k.s.files.put(bytes, "application/pdf");
    expect(id).toBe(sha256Hex(bytes));
    expect(k.s.files.put(bytes, "application/pdf")).toBe(id);
    expect(k.s.files.get(id).equals(bytes)).toBe(true);
  });

  it("refuses a file altered on disk", () => {
    const id = k.s.files.put(Buffer.from("original"), "text/plain");
    fs.writeFileSync(path.join(k.s.config.dataDir, "files", id.slice(0, 2), id), "tampered");
    expect(() => k.s.files.get(id)).toThrow(FileIntegrityError);
  });

  it("rejects ids that are not sha256 hex (no path traversal)", () => {
    expect(() => k.s.files.get("../../etc/passwd")).toThrow(/Invalid file id/);
  });
});

describe("rate limiter", () => {
  let k: TestKit;
  beforeEach(() => (k = makeTestServices()));
  afterEach(() => k.cleanup());

  it("allows up to the limit within a window, then reopens", () => {
    const hit = (t: number) => consumeRate(k.s.db, "otp:r1", 3, 60_000, t);
    expect([hit(0), hit(1), hit(2), hit(3)]).toEqual([true, true, true, false]);
    expect(hit(60_000)).toBe(true);
  });

  it("counts keys independently", () => {
    expect(consumeRate(k.s.db, "a", 1, 1000, 0)).toBe(true);
    expect(consumeRate(k.s.db, "a", 1, 1000, 1)).toBe(false);
    expect(consumeRate(k.s.db, "b", 1, 1000, 1)).toBe(true);
  });
});

describe("instance secrets", () => {
  let k: TestKit;
  beforeEach(() => (k = makeTestServices({ APP_NAME: "Acme" })));
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
