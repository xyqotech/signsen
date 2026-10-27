import { and, asc, eq } from "drizzle-orm";
import { sha256Hex } from "./crypto";
import { envelopes, recipients } from "./db/schema";
import { verifySeal, type SealCheck } from "./pdf/verify";
import type { Services } from "./services";

export interface PublicEnvelope {
  id: string;
  title: string;
  completedAt: number;
  finalSha256: string;
  participants: { name: string; email: string; role: string; status: string; actedAt: number | null }[];
}

/** "moussa.sow@example.org" → "m••••••w@example.org" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const masked = local.length <= 2 ? `${local[0] ?? ""}•` : `${local[0]}${"•".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

/** What anyone holding the QR code (an unguessable id) may learn about a completed envelope. */
export function publicEnvelope(s: Services, envelopeId: string): PublicEnvelope | null {
  if (!/^[0-9a-f-]{36}$/i.test(envelopeId)) return null;
  const env = s.db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.id, envelopeId), eq(envelopes.status, "completed")))
    .get();
  if (!env || !env.finalSha256 || !env.completedAt) return null;
  const list = s.db.select().from(recipients).where(eq(recipients.envelopeId, env.id)).orderBy(asc(recipients.position)).all();
  return {
    id: env.id,
    title: env.title,
    completedAt: env.completedAt,
    finalSha256: env.finalSha256,
    participants: list.map((r) => ({ name: r.name, email: maskEmail(r.email), role: r.role, status: r.status, actedAt: r.actedAt })),
  };
}

export interface UploadVerification {
  sha256: string;
  /** The exact file was sealed by this instance. */
  envelope: PublicEnvelope | null;
  seal: SealCheck;
  /** The seal certificate is this instance's own. */
  sealedByThisInstance: boolean;
}

export function verifyUpload(s: Services, bytes: Buffer): UploadVerification {
  const sha256 = sha256Hex(bytes);
  const match = s.db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.finalSha256, sha256), eq(envelopes.status, "completed")))
    .get();
  const seal = verifySeal(bytes);
  return {
    sha256,
    envelope: match ? publicEnvelope(s, match.id) : null,
    seal,
    sealedByThisInstance: seal.valid && seal.certificateFingerprint === s.sealIdentity().fingerprint,
  };
}
