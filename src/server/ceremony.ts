import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { appendEvent, type RequestMeta } from "./audit";
import { generateOtp, hmacHex, safeEqualHex, sha256Hex } from "./crypto";
import type { Db, Tx } from "./db/client";
import { lockEnvelope } from "./db/locks";
import { envelopes, fields, otpCodes, recipients, users, type RecipientStatus } from "./db/schema";
import { advanceRouting, deliver, type FieldView } from "./envelopes";
import { DomainError } from "./errors";
import type { MailMessage } from "./mail";
import { declinedMail, otpMail } from "./notifications";
import { consumeRate } from "./ratelimit";
import type { Services } from "./services";
import { finalizeEnvelope } from "./completion";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PER_HOUR = 5;
export const DECLINE_REASON_MAX = 500;
export const SIGNATURE_PNG_MAX_BYTES = 300 * 1024;

const ACTIVE: RecipientStatus[] = ["notified", "viewed"];

export interface CeremonyView {
  envelope: {
    id: string;
    title: string;
    message: string | null;
    status: string;
    documentName: string;
    pageCount: number;
    senderName: string;
    senderEmail: string;
    completedAt: number | null;
  };
  recipient: {
    id: string;
    name: string;
    email: string;
    role: "signer" | "approver" | "viewer";
    status: RecipientStatus;
    actedAt: number | null;
    declineReason: string | null;
  };
  /** This recipient's fields only. */
  fields: FieldView[];
  participants: { name: string; role: string; status: RecipientStatus }[];
  canAct: boolean;
  finalAvailable: boolean;
}

async function byToken(db: Db, token: string) {
  if (!token || token.length > 100) throw new DomainError("not_found");
  const [r] = await db.select().from(recipients).where(eq(recipients.tokenHash, sha256Hex(token)));
  if (!r) throw new DomainError("not_found");
  const [env] = await db.select().from(envelopes).where(eq(envelopes.id, r.envelopeId));
  return { r, env };
}

/**
 * The same lookup, to act on it: once the envelope is known its lock is taken,
 * then recipient and envelope are read again — what another request committed
 * while this one waited (a signature, a resent link, a cancellation) is seen.
 */
async function byTokenForUpdate(tx: Tx, token: string) {
  const found = await byToken(tx, token);
  await lockEnvelope(tx, found.env.id);
  return byToken(tx, token);
}

const actor = (recipientId: string) => `recipient:${recipientId}`;

/** Cheap existence check, used by the proxy to answer a real 404 before rendering. */
export async function signingLinkExists(s: Services, token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const [row] = await s.db.select({ id: recipients.id }).from(recipients).where(eq(recipients.tokenHash, sha256Hex(token)));
  return !!row;
}

export async function openCeremony(s: Services, token: string, meta: RequestMeta = {}): Promise<CeremonyView> {
  const now = s.now();
  return s.db.transaction(async (tx) => {
    const found = await byTokenForUpdate(tx, token);
    const env = found.env;
    let r = found.r;
    if (env.status === "in_progress" && r.status === "notified") {
      await tx.update(recipients).set({ status: "viewed", viewedAt: now }).where(eq(recipients.id, r.id));
      await appendEvent(tx, now, { envelopeId: env.id, type: "recipient.viewed", actor: actor(r.id), ...meta, payload: { recipientId: r.id } });
      r = { ...r, status: "viewed", viewedAt: now };
    }
    const [sender] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, env.ownerId));
    const own = await tx.select().from(fields).where(eq(fields.recipientId, r.id)).orderBy(asc(fields.page), asc(fields.y));
    const participants = await tx
      .select({ name: recipients.name, role: recipients.role, status: recipients.status })
      .from(recipients)
      .where(eq(recipients.envelopeId, env.id))
      .orderBy(asc(recipients.position));
    return {
      envelope: {
        id: env.id,
        title: env.title,
        message: env.message,
        status: env.status,
        documentName: env.documentName ?? "document.pdf",
        pageCount: env.pageCount ?? 0,
        senderName: sender.name,
        senderEmail: sender.email,
        completedAt: env.completedAt,
      },
      recipient: {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        actedAt: r.actedAt,
        declineReason: r.declineReason,
      },
      fields: own.map((f) => ({ id: f.id, recipientId: f.recipientId, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
      participants,
      canAct: env.status === "in_progress" && ACTIVE.includes(r.status) && r.role !== "viewer",
      finalAvailable: env.status === "completed" && !!env.finalSha256,
    };
  });
}

/** The document a recipient may download: the original while open, the sealed one once completed. */
export async function ceremonyDocument(s: Services, token: string) {
  const { env } = await byToken(s.db, token);
  const sha = env.status === "completed" && env.finalSha256 ? env.finalSha256 : env.documentSha256;
  if (!sha) throw new DomainError("not_found");
  const base = (env.documentName ?? "document.pdf").replace(/\.pdf$/i, "");
  return {
    bytes: s.files.get(sha),
    fileName: env.status === "completed" ? `${base} (signed).pdf` : `${base}.pdf`,
    final: env.status === "completed",
  };
}

function requireActive(r: { status: RecipientStatus; role: string }, env: { status: string }) {
  if (env.status !== "in_progress" || !ACTIVE.includes(r.status) || r.role === "viewer") {
    throw new DomainError("invalid_state");
  }
}

export async function requestCode(s: Services, token: string, meta: RequestMeta = {}) {
  const now = s.now();
  const mail = await s.db.transaction(async (tx) => {
    const { r, env } = await byTokenForUpdate(tx, token);
    requireActive(r, env);
    if (!(await consumeRate(tx, `otp:${r.id}`, OTP_PER_HOUR, 3600_000, now))) throw new DomainError("rate_limited");
    // A new code replaces any previous one.
    await tx
      .update(otpCodes)
      .set({ invalidatedAt: now })
      .where(and(eq(otpCodes.recipientId, r.id), isNull(otpCodes.consumedAt), isNull(otpCodes.invalidatedAt)));
    const code = generateOtp();
    const id = randomUUID();
    await tx
      .insert(otpCodes)
      .values({ id, recipientId: r.id, codeHash: hmacHex(s.secret, `${r.id}:${code}`), createdAt: now, expiresAt: now + OTP_TTL_MS });
    await appendEvent(tx, now, {
      envelopeId: env.id,
      type: "otp.sent",
      actor: actor(r.id),
      ...meta,
      payload: { recipientId: r.id, otpId: id, channel: "email", to: r.email },
    });
    return otpMail({ to: r.email, locale: r.locale, brand: s.config.brand, code, title: env.title });
  });
  // The code must arrive: unlike invitations, a delivery failure is reported.
  await s.mailer.send(mail);
}

type CodeCheck = { ok: true; otpId: string } | { ok: false; code: "otp_missing" | "otp_invalid" | "otp_expired" | "otp_locked" };

/**
 * Checks (and on success consumes) the recipient's current code. Failures are
 * counted. The caller's transaction holds the envelope's lock: guesses sent in
 * parallel are checked one after the other, so none escapes the attempt limit
 * and a code is consumed once.
 */
async function checkCode(tx: Tx, s: Services, r: { id: string; envelopeId: string }, input: string, now: number, meta: RequestMeta): Promise<CodeCheck> {
  const [current] = await tx
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.recipientId, r.id), isNull(otpCodes.consumedAt), isNull(otpCodes.invalidatedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!current) return { ok: false, code: "otp_missing" };
  if (current.expiresAt <= now) return { ok: false, code: "otp_expired" };
  if (current.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, code: "otp_locked" };
  const normalised = String(input ?? "").replace(/\s+/g, "");
  const matches = /^\d{6}$/.test(normalised) && safeEqualHex(hmacHex(s.secret, `${r.id}:${normalised}`), current.codeHash);
  if (!matches) {
    const attempts = current.attempts + 1;
    await tx.update(otpCodes).set({ attempts }).where(eq(otpCodes.id, current.id));
    await appendEvent(tx, now, { envelopeId: r.envelopeId, type: "otp.failed", actor: actor(r.id), ...meta, payload: { recipientId: r.id, otpId: current.id, attempts } });
    return { ok: false, code: attempts >= OTP_MAX_ATTEMPTS ? "otp_locked" : "otp_invalid" };
  }
  await tx.update(otpCodes).set({ consumedAt: now }).where(eq(otpCodes.id, current.id));
  return { ok: true, otpId: current.id };
}

/** Reads the dimensions of a PNG, refusing anything else. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export interface ActInput {
  code: string;
  consent: boolean;
  signature?: { kind: "drawn" | "typed"; png: Buffer };
}

export async function act(s: Services, token: string, input: ActInput, meta: RequestMeta = {}) {
  const { r: pre, env: preEnv } = await byToken(s.db, token);
  requireActive(pre, preEnv);
  // Consent and signature are checked before the code is touched: a missing tick
  // or an empty pad must never burn a valid code.
  if (input.consent !== true) throw new DomainError("consent_required");
  if (pre.role === "signer") {
    const png = input.signature?.png;
    const size = png ? pngSize(png) : null;
    if (!png || !size || png.length > SIGNATURE_PNG_MAX_BYTES || size.width > 3000 || size.height > 3000 || size.width < 10 || size.height < 10) {
      throw new DomainError("signature_required");
    }
  }

  const now = s.now();
  const outcome = await s.db.transaction(async (tx) => {
    const { r, env } = await byTokenForUpdate(tx, token);
    requireActive(r, env);
    const check = await checkCode(tx, s, r, input.code, now, meta);
    if (!check.ok) return { check, mails: [] as MailMessage[], complete: false, envelopeId: env.id };
    const signed = r.role === "signer";
    await tx
      .update(recipients)
      .set({
        status: signed ? "signed" : "approved",
        actedAt: now,
        signatureImage: signed ? input.signature!.png : null,
        signatureKind: signed ? input.signature!.kind : null,
      })
      .where(eq(recipients.id, r.id));
    await appendEvent(tx, now, {
      envelopeId: env.id,
      type: signed ? "recipient.signed" : "recipient.approved",
      actor: actor(r.id),
      ...meta,
      payload: {
        recipientId: r.id,
        method: "email_otp",
        otpId: check.otpId,
        consent: true,
        documentSha256: env.documentSha256,
        ...(signed ? { signatureKind: input.signature!.kind, signatureSha256: sha256Hex(input.signature!.png) } : {}),
      },
    });
    await tx.update(envelopes).set({ updatedAt: now }).where(eq(envelopes.id, env.id));
    const next = await advanceRouting(tx, s, env.id, now);
    return { check, mails: next.mails, complete: next.complete, envelopeId: env.id };
  });

  if (!outcome.check.ok) throw new DomainError(outcome.check.code);
  await deliver(s, outcome.mails);
  if (outcome.complete) await finalizeEnvelope(s, outcome.envelopeId);
}

export async function decline(s: Services, token: string, input: { code: string; reason: string }, meta: RequestMeta = {}) {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 1 || reason.length > DECLINE_REASON_MAX) {
    throw new DomainError("validation", undefined, { fields: { reason: reason ? "too_long" : "required" } });
  }
  const { r: pre, env: preEnv } = await byToken(s.db, token);
  requireActive(pre, preEnv);

  const now = s.now();
  const outcome = await s.db.transaction(async (tx) => {
    const { r, env } = await byTokenForUpdate(tx, token);
    requireActive(r, env);
    const check = await checkCode(tx, s, r, input.code, now, meta);
    if (!check.ok) return { check, mails: [] as MailMessage[] };
    await tx.update(recipients).set({ status: "declined", actedAt: now, declineReason: reason }).where(eq(recipients.id, r.id));
    await tx.update(envelopes).set({ status: "declined", closedAt: now, updatedAt: now }).where(eq(envelopes.id, env.id));
    await appendEvent(tx, now, {
      envelopeId: env.id,
      type: "recipient.declined",
      actor: actor(r.id),
      ...meta,
      payload: { recipientId: r.id, method: "email_otp", otpId: check.otpId, reason },
    });
    const [ownerRow] = await tx.select().from(users).where(eq(users.id, env.ownerId));
    const others = await tx
      .select()
      .from(recipients)
      .where(and(eq(recipients.envelopeId, env.id), inArray(recipients.status, ACTIVE)));
    const mails = [
      declinedMail({ to: ownerRow.email, locale: ownerRow.locale, brand: s.config.brand, name: ownerRow.name, title: env.title, declinedBy: r.name, reason }),
      // Other participants learn the request is closed, not why: the reason is for the sender.
      ...others.map((o) =>
        declinedMail({ to: o.email, locale: o.locale, brand: s.config.brand, name: o.name, title: env.title, declinedBy: r.name, reason: null }),
      ),
    ];
    return { check, mails };
  });
  if (!outcome.check.ok) throw new DomainError(outcome.check.code);
  await deliver(s, outcome.mails);
}
