import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { appendEvent, listEvents, verifyChain } from "./audit";
import { lockEnvelope } from "./db/locks";
import { envelopes, events, fields, recipients, users } from "./db/schema";
import { deliver } from "./envelopes";
import { completedMail } from "./notifications";
import { buildFinalPdf } from "./pdf/finalize";
import type { Services } from "./services";

const inFlight = new Set<string>();

/**
 * Seals and closes an envelope once every signer and approver has acted.
 * Safe to call again (e.g. after a crash): it does nothing unless the envelope
 * is still in progress with nobody left to act.
 */
export async function finalizeEnvelope(s: Services, envelopeId: string): Promise<"completed" | "not_ready" | "already_done"> {
  if (inFlight.has(envelopeId)) return "already_done";
  inFlight.add(envelopeId);
  try {
    return await finalize(s, envelopeId);
  } finally {
    inFlight.delete(envelopeId);
  }
}

async function finalize(s: Services, envelopeId: string) {
  const [env] = await s.db.select().from(envelopes).where(eq(envelopes.id, envelopeId));
  if (!env || env.status === "completed") return "already_done" as const;
  if (env.status !== "in_progress" || !env.documentSha256 || !env.sentAt) return "not_ready" as const;
  const list = await s.db.select().from(recipients).where(eq(recipients.envelopeId, envelopeId)).orderBy(asc(recipients.position));
  if (list.some((r) => r.role !== "viewer" && r.status !== "signed" && r.status !== "approved")) return "not_ready" as const;

  const chain = await verifyChain(s.db, envelopeId);
  if (!chain.ok) throw new Error(`Audit chain of ${envelopeId} is broken at event ${chain.brokenAtEventId}; refusing to seal`);

  const [owner] = await s.db.select().from(users).where(eq(users.id, env.ownerId));
  const history = await listEvents(s.db, envelopeId);
  const placed = await s.db.select().from(fields).where(eq(fields.envelopeId, envelopeId));
  const names = new Map<string, string>([[`owner:${owner.id}`, owner.name], ["system", s.config.brand.name]]);
  for (const r of list) names.set(`recipient:${r.id}`, r.name);

  // IP and device are taken from the event where each participant acted.
  const actedEvent = (recipientId: string) =>
    [...history].reverse().find((e) => (e.type === "recipient.signed" || e.type === "recipient.approved") && e.actor === `recipient:${recipientId}`);

  const completedAt = s.now();
  const sealed = await buildFinalPdf({
    original: s.files.get(env.documentSha256),
    locale: owner.locale,
    brandName: s.config.brand.name,
    appUrl: s.config.appUrl,
    envelope: {
      id: env.id,
      title: env.title,
      documentName: env.documentName ?? "document.pdf",
      originalSha256: env.documentSha256,
      ownerName: owner.name,
      ownerEmail: owner.email,
      sentAt: env.sentAt,
      completedAt,
    },
    recipients: list.map((r) => {
      const ev = actedEvent(r.id);
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        viewedAt: r.viewedAt,
        actedAt: r.actedAt,
        ip: ev?.ip ?? null,
        userAgent: ev?.userAgent ?? null,
        signatureImage: r.signatureImage,
      };
    }),
    fields: placed.map((f) => ({ recipientId: f.recipientId, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
    events: history
      .filter((e) => !e.type.startsWith("otp."))
      .map((e) => ({ createdAt: e.createdAt, type: e.type, actorLabel: names.get(e.actor) ?? e.actor })),
    auditChainHash: chain.lastHash,
    seal: s.sealIdentity(),
  });
  const finalSha256 = await s.files.put(sealed, "application/pdf");

  const committed = await s.db.transaction(async (tx) => {
    // The PDF was built outside any transaction: under the envelope's lock,
    // make sure nothing changed meanwhile (another instance completed it, the
    // owner cancelled it) before recording the result.
    await lockEnvelope(tx, envelopeId);
    const [current] = await tx.select({ status: envelopes.status }).from(envelopes).where(eq(envelopes.id, envelopeId));
    if (current?.status !== "in_progress") return false;
    const [head] = await tx.select({ hash: events.hash }).from(events).where(eq(events.envelopeId, envelopeId)).orderBy(desc(events.id)).limit(1);
    if (head?.hash !== chain.lastHash) {
      throw new Error(`Audit chain of ${envelopeId} moved while its certificate was being built; refusing to seal`);
    }
    await tx.update(envelopes).set({ status: "completed", finalSha256, completedAt, updatedAt: completedAt }).where(eq(envelopes.id, envelopeId));
    await tx
      .update(recipients)
      .set({ status: "notified" })
      .where(and(eq(recipients.envelopeId, envelopeId), inArray(recipients.role, ["viewer"])));
    await appendEvent(tx, completedAt, { envelopeId, type: "envelope.completed", actor: "system", payload: { finalSha256 } });
    const seal = s.sealIdentity();
    await appendEvent(tx, completedAt, {
      envelopeId,
      type: "envelope.sealed",
      actor: "system",
      payload: { finalSha256, sealSubject: seal.subject, sealFingerprint: seal.fingerprint, format: "adbe.pkcs7.detached" },
    });
    return true;
  });
  if (!committed) return "already_done" as const;

  const fileName = `${(env.documentName ?? "document.pdf").replace(/\.pdf$/i, "")} (signed).pdf`;
  const brand = s.config.brand;
  await deliver(s, [
    completedMail({ to: owner.email, locale: owner.locale, brand, name: owner.name, title: env.title, fileName, pdf: sealed, sha256: finalSha256 }),
    ...list.map((r) =>
      completedMail({ to: r.email, locale: r.locale, brand, name: r.name, title: env.title, fileName, pdf: sealed, sha256: finalSha256 }),
    ),
  ]);
  return "completed" as const;
}
