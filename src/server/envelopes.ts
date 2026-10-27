import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { appendEvent, type RequestMeta } from "./audit";
import { fieldErrors } from "./auth";
import type { Locale } from "./config";
import { randomToken, sha256Hex } from "./crypto";
import type { Db } from "./db/client";
import {
  envelopes,
  fields,
  recipients,
  users,
  type EnvelopeStatus,
  type RecipientRole,
  type RecipientStatus,
} from "./db/schema";
import { DomainError } from "./errors";
import type { MailMessage } from "./mail";
import { cancelledMail, invitationMail } from "./notifications";
import { inspectPdf } from "./pdf/inspect";
import type { Services } from "./services";

export const MAX_RECIPIENTS = 25;
export const MAX_FIELDS = 200;

export interface RecipientView {
  id: string;
  position: number;
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
  status: RecipientStatus;
  locale: Locale;
  viewedAt: number | null;
  actedAt: number | null;
  declineReason: string | null;
}

export interface FieldView {
  id: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EnvelopeView {
  id: string;
  title: string;
  message: string | null;
  status: EnvelopeStatus;
  documentName: string | null;
  documentSha256: string | null;
  pageCount: number | null;
  finalSha256: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  completedAt: number | null;
  closedAt: number | null;
  recipients: RecipientView[];
  fields: FieldView[];
}

const ACTED: RecipientStatus[] = ["signed", "approved", "declined"];
const ACTIVE: RecipientStatus[] = ["notified", "viewed"];

const owner = (id: string) => `owner:${id}`;

function invalid(error: z.ZodError): never {
  throw new DomainError("validation", undefined, { fields: fieldErrors(error) });
}

/** Loads an envelope of this owner, or fails exactly as if it did not exist. */
function ownedEnvelope(db: Db, ownerId: string, envelopeId: string) {
  const row = db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.id, envelopeId), eq(envelopes.ownerId, ownerId)))
    .get();
  if (!row) throw new DomainError("not_found");
  return row;
}

function requireDraft(env: { status: EnvelopeStatus }) {
  if (env.status !== "draft") throw new DomainError("invalid_state", "The envelope is no longer a draft");
}

function touch(db: Db, envelopeId: string, now: number) {
  db.update(envelopes).set({ updatedAt: now }).where(eq(envelopes.id, envelopeId)).run();
}

// ─── Drafting ────────────────────────────────────────────────────────────────

const detailsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : null)),
});

export function createEnvelope(s: Services, ownerId: string, input: z.input<typeof detailsSchema>, meta: RequestMeta = {}) {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  const id = randomUUID();
  s.db.transaction((tx) => {
    tx.insert(envelopes)
      .values({ id, ownerId, title: parsed.data.title, message: parsed.data.message, status: "draft", createdAt: now, updatedAt: now })
      .run();
    appendEvent(tx, now, { envelopeId: id, type: "envelope.created", actor: owner(ownerId), ...meta, payload: { title: parsed.data.title } });
  });
  return getEnvelope(s, ownerId, id);
}

export function updateEnvelope(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof detailsSchema>,
  meta: RequestMeta = {},
) {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  s.db.transaction((tx) => {
    requireDraft(ownedEnvelope(tx, ownerId, envelopeId));
    tx.update(envelopes)
      .set({ title: parsed.data.title, message: parsed.data.message, updatedAt: now })
      .where(eq(envelopes.id, envelopeId))
      .run();
    appendEvent(tx, now, { envelopeId, type: "envelope.updated", actor: owner(ownerId), ...meta, payload: { title: parsed.data.title } });
  });
  return getEnvelope(s, ownerId, envelopeId);
}

export async function attachDocument(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: { name: string; bytes: Buffer },
  meta: RequestMeta = {},
) {
  requireDraft(ownedEnvelope(s.db, ownerId, envelopeId));
  const info = await inspectPdf(input.bytes);
  const name = sanitizeFileName(input.name);
  const sha256 = s.files.put(input.bytes, "application/pdf");
  const now = s.now();
  s.db.transaction((tx) => {
    requireDraft(ownedEnvelope(tx, ownerId, envelopeId)); // re-checked: the await above let time pass
    tx.update(envelopes)
      .set({ documentSha256: sha256, documentName: name, pageCount: info.pageCount, updatedAt: now })
      .where(eq(envelopes.id, envelopeId))
      .run();
    // A new document invalidates fields placed on the previous one.
    tx.delete(fields).where(eq(fields.envelopeId, envelopeId)).run();
    appendEvent(tx, now, {
      envelopeId,
      type: "document.attached",
      actor: owner(ownerId),
      ...meta,
      payload: { name, sha256, pages: info.pageCount, bytes: input.bytes.length },
    });
  });
  return getEnvelope(s, ownerId, envelopeId);
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .trim()
    .slice(0, 150);
  if (!cleaned) return "document.pdf";
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

const recipientSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  role: z.enum(["signer", "approver", "viewer"]),
  routingOrder: z.coerce.number().int().min(1).max(MAX_RECIPIENTS).default(1),
  locale: z.enum(["fr", "en"]).optional(),
});

export function addRecipient(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof recipientSchema>,
  meta: RequestMeta = {},
): RecipientView {
  const parsed = recipientSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const data = { ...parsed.data, email: parsed.data.email.toLowerCase() };
  const now = s.now();
  const id = randomUUID();
  s.db.transaction((tx) => {
    requireDraft(ownedEnvelope(tx, ownerId, envelopeId));
    const existing = tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId)).all();
    if (existing.length >= MAX_RECIPIENTS) throw new DomainError("validation", "Too many recipients", { fields: { _: "too_many" } });
    if (existing.some((r) => r.email === data.email)) {
      throw new DomainError("validation", "Duplicate recipient", { fields: { email: "duplicate" } });
    }
    const ownerLocale = tx.select({ locale: users.locale }).from(users).where(eq(users.id, ownerId)).get()?.locale;
    tx.insert(recipients)
      .values({
        id,
        envelopeId,
        position: existing.length === 0 ? 1 : Math.max(...existing.map((r) => r.position)) + 1,
        name: data.name,
        email: data.email,
        role: data.role,
        routingOrder: data.routingOrder,
        status: "waiting",
        locale: data.locale ?? ownerLocale ?? s.config.defaultLocale,
      })
      .run();
    touch(tx, envelopeId, now);
    appendEvent(tx, now, {
      envelopeId,
      type: "recipient.added",
      actor: owner(ownerId),
      ...meta,
      payload: { recipientId: id, name: data.name, email: data.email, role: data.role, routingOrder: data.routingOrder },
    });
  });
  return getEnvelope(s, ownerId, envelopeId).recipients.find((r) => r.id === id)!;
}

export function removeRecipient(s: Services, ownerId: string, envelopeId: string, recipientId: string, meta: RequestMeta = {}) {
  const now = s.now();
  s.db.transaction((tx) => {
    requireDraft(ownedEnvelope(tx, ownerId, envelopeId));
    const removed = tx
      .delete(recipients)
      .where(and(eq(recipients.id, recipientId), eq(recipients.envelopeId, envelopeId)))
      .returning({ id: recipients.id })
      .all();
    if (removed.length === 0) throw new DomainError("not_found");
    touch(tx, envelopeId, now);
    appendEvent(tx, now, { envelopeId, type: "recipient.removed", actor: owner(ownerId), ...meta, payload: { recipientId } });
  });
  return getEnvelope(s, ownerId, envelopeId);
}

const fieldSchema = z
  .object({
    recipientId: z.string().min(1),
    page: z.number().int().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.03).max(1),
    height: z.number().min(0.015).max(1),
  })
  .refine((f) => f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001, { message: "outside_page" });

/** Replaces every field of the envelope. */
export function setFields(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof fieldSchema>[],
  meta: RequestMeta = {},
) {
  const parsed = z.array(fieldSchema).max(MAX_FIELDS).safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  s.db.transaction((tx) => {
    const env = ownedEnvelope(tx, ownerId, envelopeId);
    requireDraft(env);
    if (!env.pageCount) throw new DomainError("invalid_state", "Attach a document first");
    const signers = new Set(
      tx
        .select({ id: recipients.id })
        .from(recipients)
        .where(and(eq(recipients.envelopeId, envelopeId), eq(recipients.role, "signer")))
        .all()
        .map((r) => r.id),
    );
    for (const f of parsed.data) {
      if (!signers.has(f.recipientId)) throw new DomainError("validation", "Field for a non-signer", { fields: { recipientId: "not_a_signer" } });
      if (f.page > env.pageCount) throw new DomainError("validation", "Field outside the document", { fields: { page: "out_of_range" } });
    }
    tx.delete(fields).where(eq(fields.envelopeId, envelopeId)).run();
    for (const f of parsed.data) tx.insert(fields).values({ id: randomUUID(), envelopeId, ...f }).run();
    touch(tx, envelopeId, now);
    appendEvent(tx, now, { envelopeId, type: "fields.updated", actor: owner(ownerId), ...meta, payload: { count: parsed.data.length } });
  });
  return getEnvelope(s, ownerId, envelopeId);
}

// ─── Sending and routing ─────────────────────────────────────────────────────

export interface PendingMail {
  message: MailMessage;
}

/**
 * Notifies the recipients of the current routing round. Runs inside the caller's
 * transaction and returns the invitations to send once it has committed.
 * Returns `complete: true` when no signer/approver is left to act.
 */
export function advanceRouting(tx: Db, s: Services, envelopeId: string, now: number): { mails: MailMessage[]; complete: boolean } {
  const env = tx.select().from(envelopes).where(eq(envelopes.id, envelopeId)).get()!;
  const all = tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId)).orderBy(asc(recipients.position)).all();
  const actors = all.filter((r) => r.role !== "viewer");
  const remaining = actors.filter((r) => !ACTED.includes(r.status));
  if (remaining.length === 0) return { mails: [], complete: true };

  const round = Math.min(...remaining.map((r) => r.routingOrder));
  const sender = tx.select({ name: users.name }).from(users).where(eq(users.id, env.ownerId)).get()!;
  const mails: MailMessage[] = [];
  for (const r of remaining) {
    if (r.routingOrder !== round || r.status !== "waiting") continue;
    const token = randomToken();
    tx.update(recipients).set({ status: "notified", tokenHash: sha256Hex(token) }).where(eq(recipients.id, r.id)).run();
    appendEvent(tx, now, { envelopeId, type: "recipient.notified", actor: "system", payload: { recipientId: r.id, email: r.email } });
    mails.push(
      invitationMail({
        to: r.email,
        locale: r.locale,
        brand: s.config.brand,
        recipientName: r.name,
        senderName: sender.name,
        title: env.title,
        message: env.message,
        role: r.role as "signer" | "approver",
        link: `${s.config.appUrl}/s/${token}`,
      }),
    );
  }
  return { mails, complete: false };
}

export async function deliver(s: Services, mails: MailMessage[]) {
  for (const m of mails) {
    try {
      await s.mailer.send(m);
    } catch (e) {
      // The state is committed; the owner can resend the invitation from the dashboard.
      console.error(`[mail] delivery to ${m.to} failed:`, e);
    }
  }
}

export async function sendEnvelope(s: Services, ownerId: string, envelopeId: string, meta: RequestMeta = {}) {
  const now = s.now();
  const mails = s.db.transaction((tx) => {
    const env = ownedEnvelope(tx, ownerId, envelopeId);
    requireDraft(env);
    const problems: string[] = [];
    if (!env.documentSha256) problems.push("no_document");
    const list = tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId)).all();
    const actors = list.filter((r) => r.role !== "viewer");
    if (actors.length === 0) problems.push("no_signer");
    const placed = new Set(tx.select({ r: fields.recipientId }).from(fields).where(eq(fields.envelopeId, envelopeId)).all().map((f) => f.r));
    const withoutField = list.filter((r) => r.role === "signer" && !placed.has(r.id)).map((r) => r.id);
    if (withoutField.length) problems.push("signer_without_field");
    if (problems.length) throw new DomainError("invalid_state", "Not ready to send", { problems, recipients: withoutField });

    tx.update(envelopes).set({ status: "in_progress", sentAt: now, updatedAt: now }).where(eq(envelopes.id, envelopeId)).run();
    appendEvent(tx, now, {
      envelopeId,
      type: "envelope.sent",
      actor: owner(ownerId),
      ...meta,
      payload: { documentSha256: env.documentSha256, recipients: list.length },
    });
    return advanceRouting(tx, s, envelopeId, now).mails;
  });
  await deliver(s, mails);
  return getEnvelope(s, ownerId, envelopeId);
}

/** Issues a fresh link for a recipient whose turn it is (the old link stops working). */
export async function resendInvitation(s: Services, ownerId: string, envelopeId: string, recipientId: string, meta: RequestMeta = {}) {
  const now = s.now();
  const mail = s.db.transaction((tx) => {
    const env = ownedEnvelope(tx, ownerId, envelopeId);
    if (env.status !== "in_progress") throw new DomainError("invalid_state");
    const r = tx
      .select()
      .from(recipients)
      .where(and(eq(recipients.id, recipientId), eq(recipients.envelopeId, envelopeId)))
      .get();
    if (!r) throw new DomainError("not_found");
    if (!ACTIVE.includes(r.status)) throw new DomainError("invalid_state", "Not this recipient's turn");
    const token = randomToken();
    tx.update(recipients).set({ tokenHash: sha256Hex(token) }).where(eq(recipients.id, r.id)).run();
    appendEvent(tx, now, { envelopeId, type: "recipient.notified", actor: owner(ownerId), ...meta, payload: { recipientId: r.id, email: r.email, resent: true } });
    const sender = tx.select({ name: users.name }).from(users).where(eq(users.id, ownerId)).get()!;
    return invitationMail({
      to: r.email,
      locale: r.locale,
      brand: s.config.brand,
      recipientName: r.name,
      senderName: sender.name,
      title: env.title,
      message: env.message,
      role: r.role as "signer" | "approver",
      link: `${s.config.appUrl}/s/${token}`,
    });
  });
  await deliver(s, [mail]);
}

export async function cancelEnvelope(s: Services, ownerId: string, envelopeId: string, meta: RequestMeta = {}) {
  const now = s.now();
  const mails = s.db.transaction((tx) => {
    const env = ownedEnvelope(tx, ownerId, envelopeId);
    if (env.status !== "in_progress") throw new DomainError("invalid_state");
    tx.update(envelopes).set({ status: "cancelled", closedAt: now, updatedAt: now }).where(eq(envelopes.id, envelopeId)).run();
    appendEvent(tx, now, { envelopeId, type: "envelope.cancelled", actor: owner(ownerId), ...meta });
    const sender = tx.select({ name: users.name }).from(users).where(eq(users.id, ownerId)).get()!;
    return tx
      .select()
      .from(recipients)
      .where(and(eq(recipients.envelopeId, envelopeId), inArray(recipients.status, ACTIVE)))
      .all()
      .map((r) =>
        cancelledMail({ to: r.email, locale: r.locale, brand: s.config.brand, name: r.name, title: env.title, senderName: sender.name }),
      );
  });
  await deliver(s, mails);
  return getEnvelope(s, ownerId, envelopeId);
}

export function deleteEnvelope(s: Services, ownerId: string, envelopeId: string, meta: RequestMeta = {}) {
  const now = s.now();
  s.db.transaction((tx) => {
    requireDraft(ownedEnvelope(tx, ownerId, envelopeId));
    appendEvent(tx, now, { envelopeId, type: "envelope.deleted", actor: owner(ownerId), ...meta });
    tx.delete(envelopes).where(eq(envelopes.id, envelopeId)).run();
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Used by the proxy: true only when this owner owns this envelope. */
export function ownsEnvelope(s: Services, ownerId: string, envelopeId: string): boolean {
  return !!s.db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.id, envelopeId), eq(envelopes.ownerId, ownerId)))
    .get();
}

export function getEnvelope(s: Services, ownerId: string, envelopeId: string): EnvelopeView {
  return toView(s.db, ownedEnvelope(s.db, ownerId, envelopeId));
}

export function toView(db: Db, env: typeof envelopes.$inferSelect): EnvelopeView {
  const recips = db.select().from(recipients).where(eq(recipients.envelopeId, env.id)).orderBy(asc(recipients.position)).all();
  const flds = db.select().from(fields).where(eq(fields.envelopeId, env.id)).orderBy(asc(fields.page), asc(fields.y)).all();
  return {
    id: env.id,
    title: env.title,
    message: env.message,
    status: env.status,
    documentName: env.documentName,
    documentSha256: env.documentSha256,
    pageCount: env.pageCount,
    finalSha256: env.finalSha256,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
    sentAt: env.sentAt,
    completedAt: env.completedAt,
    closedAt: env.closedAt,
    recipients: recips.map((r) => ({
      id: r.id,
      position: r.position,
      name: r.name,
      email: r.email,
      role: r.role,
      routingOrder: r.routingOrder,
      status: r.status,
      locale: r.locale,
      viewedAt: r.viewedAt,
      actedAt: r.actedAt,
      declineReason: r.declineReason,
    })),
    fields: flds.map((f) => ({ id: f.id, recipientId: f.recipientId, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
  };
}

export interface ListQuery {
  status?: EnvelopeStatus | "all";
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface EnvelopeSummary {
  id: string;
  title: string;
  status: EnvelopeStatus;
  updatedAt: number;
  sentAt: number | null;
  completedAt: number | null;
  recipients: { name: string; status: RecipientStatus; role: RecipientRole }[];
}

export function listEnvelopes(s: Services, ownerId: string, q: ListQuery = {}) {
  const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  const where: SQL[] = [eq(envelopes.ownerId, ownerId)];
  if (q.status && q.status !== "all") where.push(eq(envelopes.status, q.status));
  // LIKE wildcards are dropped from the term (drizzle's like() has no ESCAPE clause).
  const term = q.query?.replace(/[%_]/g, "").trim();
  if (term) {
    const pattern = `%${term}%`;
    const matchingRecipients = s.db
      .select({ id: recipients.envelopeId })
      .from(recipients)
      .where(or(like(recipients.name, pattern), like(recipients.email, pattern)));
    where.push(or(like(envelopes.title, pattern), inArray(envelopes.id, matchingRecipients))!);
  }
  const condition = and(...where);
  const total = s.db.select({ n: count() }).from(envelopes).where(condition).get()!.n;
  const rows = s.db
    .select()
    .from(envelopes)
    .where(condition)
    .orderBy(desc(envelopes.updatedAt), desc(envelopes.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const recips = rows.length
    ? s.db
        .select({ envelopeId: recipients.envelopeId, name: recipients.name, status: recipients.status, role: recipients.role })
        .from(recipients)
        .where(inArray(recipients.envelopeId, rows.map((r) => r.id)))
        .orderBy(asc(recipients.position))
        .all()
    : [];
  const items: EnvelopeSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    updatedAt: r.updatedAt,
    sentAt: r.sentAt,
    completedAt: r.completedAt,
    recipients: recips.filter((x) => x.envelopeId === r.id).map(({ name, status, role }) => ({ name, status, role })),
  }));
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function ownerDocument(s: Services, ownerId: string, envelopeId: string, which: "original" | "final") {
  const env = ownedEnvelope(s.db, ownerId, envelopeId);
  const sha = which === "final" ? env.finalSha256 : env.documentSha256;
  if (!sha) throw new DomainError("not_found");
  const base = (env.documentName ?? "document.pdf").replace(/\.pdf$/i, "");
  return { bytes: s.files.get(sha), fileName: which === "final" ? `${base} (signed).pdf` : `${base}.pdf` };
}
