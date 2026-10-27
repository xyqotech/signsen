import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./crypto";
import type { Db } from "./db/client";
import { files } from "./db/schema";

export interface FileStore {
  /** Stores bytes once (content-addressed) and returns their sha256. */
  put(bytes: Buffer, mime: string): string;
  /** Returns the bytes, after checking they still match their hash. */
  get(sha256: string): Buffer;
}

export class FileIntegrityError extends Error {
  constructor(sha256: string) {
    super(`Stored file ${sha256} no longer matches its hash`);
    this.name = "FileIntegrityError";
  }
}

/**
 * Creates a folder readable only by its owner, and tightens one that already
 * exists (an operator may have created DATA_DIR before the first start).
 */
export function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    // A mounted folder owned by someone else: its files stay 0600 anyway.
    console.warn(`Could not restrict ${dir} to its owner: ${(e as Error).message}`);
  }
}

export function createFileStore(db: Db, dir: string, now: () => number): FileStore {
  privateDir(dir);

  const locate = (sha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid file id");
    return path.join(dir, sha256.slice(0, 2), sha256);
  };

  return {
    put(bytes, mime) {
      const sha256 = sha256Hex(bytes);
      const target = locate(sha256);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, bytes, { mode: 0o600 });
        fs.renameSync(tmp, target);
      }
      db.insert(files)
        .values({ sha256, size: bytes.length, mime, createdAt: now() })
        .onConflictDoNothing()
        .run();
      return sha256;
    },
    get(sha256) {
      const bytes = fs.readFileSync(locate(sha256));
      if (sha256Hex(bytes) !== sha256) throw new FileIntegrityError(sha256);
      return bytes;
    },
  };
}
