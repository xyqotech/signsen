import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, inArray, ne, notInArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { appendEvent, type RequestMeta } from "./audit";
import { fieldErrors } from "./auth";
import type { Locale } from "./config";
import { randomToken, sha256Hex } from "./crypto";
import type { Db, Tx } from "./db/client";
import { lockEnvelope } from "./db/locks";
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
/** What a signer or an approver ends on when the request goes through: the rule of the seal. */
const DONE: RecipientStatus[] = ["signed", "approved"];

const owner = (id: string) => `owner:${id}`;

function invalid(error: z.ZodError): never {
  throw new DomainError("validation", undefined, { fields: fieldErrors(error) });
}

/** Loads an envelope of this owner, or fails exactly as if it did not exist. */
async function ownedEnvelope(db: Db, ownerId: string, envelopeId: string) {
  const [row] = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.id, envelopeId), eq(envelopes.ownerId, ownerId)));
  if (!row) throw new DomainError("not_found");
  return row;
}

/**
 * The same, to change it: the envelope's lock is taken first, so the state read
 * here (draft or not, recipients, fields) cannot change under this transaction.
 */
async function ownedEnvelopeForUpdate(tx: Tx, ownerId: string, envelopeId: string) {
  await lockEnvelope(tx, envelopeId);
  return ownedEnvelope(tx, ownerId, envelopeId);
}

function requireDraft(env: { status: EnvelopeStatus }) {
  if (env.status !== "draft") throw new DomainError("invalid_state", "The envelope is no longer a draft");
}

async function touch(tx: Tx, envelopeId: string, now: number) {
  await tx.update(envelopes).set({ updatedAt: now }).where(eq(envelopes.id, envelopeId));
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

export async function createEnvelope(s: Services, ownerId: string, input: z.input<typeof detailsSchema>, meta: RequestMeta = {}) {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  const id = randomUUID();
  await s.db.transaction(async (tx) => {
    await tx
      .insert(envelopes)
      .values({ id, ownerId, title: parsed.data.title, message: parsed.data.message, status: "draft", createdAt: now, updatedAt: now });
    await appendEvent(tx, now, { envelopeId: id, type: "envelope.created", actor: owner(ownerId), ...meta, payload: { title: parsed.data.title } });
  });
  return getEnvelope(s, ownerId, id);
}

export async function updateEnvelope(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof detailsSchema>,
  meta: RequestMeta = {},
) {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  await s.db.transaction(async (tx) => {
    const env = await ownedEnvelopeForUpdate(tx, ownerId, envelopeId);
    requireDraft(env);
    // The editor saves on its own (a field losing focus, sending): no event when nothing changed.
    if (env.title === parsed.data.title && env.message === parsed.data.message) return;
    await tx
      .update(envelopes)
      .set({ title: parsed.data.title, message: parsed.data.message, updatedAt: now })
      .where(eq(envelopes.id, envelopeId));
    await appendEvent(tx, now, { envelopeId, type: "envelope.updated", actor: owner(ownerId), ...meta, payload: { title: parsed.data.title } });
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
  requireDraft(await ownedEnvelope(s.db, ownerId, envelopeId));
  const info = await inspectPdf(input.bytes);
  const name = sanitizeFileName(input.name);
  const sha256 = await s.files.put(input.bytes, "application/pdf");
  const now = s.now();
  await s.db.transaction(async (tx) => {
    requireDraft(await ownedEnvelopeForUpdate(tx, ownerId, envelopeId)); // re-checked: the awaits above let time pass
    await tx
      .update(envelopes)
      .set({ documentSha256: sha256, documentName: name, pageCount: info.pageCount, updatedAt: now })
      .where(eq(envelopes.id, envelopeId));
    // A new document invalidates fields placed on the previous one.
    await tx.delete(fields).where(eq(fields.envelopeId, envelopeId));
    await appendEvent(tx, now, {
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

export async function addRecipient(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof recipientSchema>,
  meta: RequestMeta = {},
): Promise<RecipientView> {
  const parsed = recipientSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const data = { ...parsed.data, email: parsed.data.email.toLowerCase() };
  const now = s.now();
  const id = randomUUID();
  await s.db.transaction(async (tx) => {
    requireDraft(await ownedEnvelopeForUpdate(tx, ownerId, envelopeId));
    const existing = await tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId));
    if (existing.length >= MAX_RECIPIENTS) throw new DomainError("validation", "Too many recipients", { fields: { _: "too_many" } });
    if (existing.some((r) => r.email === data.email)) {
      throw new DomainError("validation", "Duplicate recipient", { fields: { email: "duplicate" } });
    }
    const [ownerRow] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, ownerId));
    await tx.insert(recipients).values({
      id,
      envelopeId,
      position: existing.length === 0 ? 1 : Math.max(...existing.map((r) => r.position)) + 1,
      name: data.name,
      email: data.email,
      role: data.role,
      routingOrder: data.routingOrder,
      status: "waiting",
      locale: data.locale ?? ownerRow?.locale ?? s.config.defaultLocale,
    });
    await touch(tx, envelopeId, now);
    await appendEvent(tx, now, {
      envelopeId,
      type: "recipient.added",
      actor: owner(ownerId),
      ...meta,
      payload: { recipientId: id, name: data.name, email: data.email, role: data.role, routingOrder: data.routingOrder },
    });
  });
  return (await getEnvelope(s, ownerId, envelopeId)).recipients.find((r) => r.id === id)!;
}

export async function removeRecipient(s: Services, ownerId: string, envelopeId: string, recipientId: string, meta: RequestMeta = {}) {
  const now = s.now();
  await s.db.transaction(async (tx) => {
    requireDraft(await ownedEnvelopeForUpdate(tx, ownerId, envelopeId));
    const removed = await tx
      .delete(recipients)
      .where(and(eq(recipients.id, recipientId), eq(recipients.envelopeId, envelopeId)))
      .returning({ id: recipients.id });
    if (removed.length === 0) throw new DomainError("not_found");
    await touch(tx, envelopeId, now);
    await appendEvent(tx, now, { envelopeId, type: "recipient.removed", actor: owner(ownerId), ...meta, payload: { recipientId } });
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
export async function setFields(
  s: Services,
  ownerId: string,
  envelopeId: string,
  input: z.input<typeof fieldSchema>[],
  meta: RequestMeta = {},
) {
  const parsed = z.array(fieldSchema).max(MAX_FIELDS).safeParse(input);
  if (!parsed.success) invalid(parsed.error);
  const now = s.now();
  await s.db.transaction(async (tx) => {
    const env = await ownedEnvelopeForUpdate(tx, ownerId, envelopeId);
    requireDraft(env);
    if (!env.pageCount) throw new DomainError("invalid_state", "Attach a document first");
    const signerRows = await tx
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(eq(recipients.envelopeId, envelopeId), eq(recipients.role, "signer")));
    const signers = new Set(signerRows.map((r) => r.id));
    for (const f of parsed.data) {
      if (!signers.has(f.recipientId)) throw new DomainError("validation", "Field for a non-signer", { fields: { recipientId: "not_a_signer" } });
      if (f.page > env.pageCount) throw new DomainError("validation", "Field outside the document", { fields: { page: "out_of_range" } });
    }
    await tx.delete(fields).where(eq(fields.envelopeId, envelopeId));
    if (parsed.data.length > 0) {
      await tx.insert(fields).values(parsed.data.map((f) => ({ id: randomUUID(), envelopeId, ...f })));
    }
    await touch(tx, envelopeId, now);
    await appendEvent(tx, now, { envelopeId, type: "fields.updated", actor: owner(ownerId), ...meta, payload: { count: parsed.data.length } });
  });
  return getEnvelope(s, ownerId, envelopeId);
}

// ─── Sending and routing ─────────────────────────────────────────────────────

export interface PendingMail {
  message: MailMessage;
}

/**
 * Notifies the recipients of the current routing round. Runs inside the caller's
 * transaction (which holds the envelope's lock) and returns the invitations to
 * send once it has committed. Returns `complete: true` when no signer/approver
 * is left to act.
 */
export async function advanceRouting(tx: Tx, s: Services, envelopeId: string, now: number): Promise<{ mails: MailMessage[]; complete: boolean }> {
  const [env] = await tx.select().from(envelopes).where(eq(envelopes.id, envelopeId));
  const all = await tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId)).orderBy(asc(recipients.position));
  const actors = all.filter((r) => r.role !== "viewer");
  const remaining = actors.filter((r) => !ACTED.includes(r.status));
  if (remaining.length === 0) return { mails: [], complete: true };

  const round = Math.min(...remaining.map((r) => r.routingOrder));
  const [sender] = await tx.select({ name: users.name }).from(users).where(eq(users.id, env.ownerId));
  const mails: MailMessage[] = [];
  for (const r of remaining) {
    if (r.routingOrder !== round || r.status !== "waiting") continue;
    const token = randomToken();
    await tx.update(recipients).set({ status: "notified", tokenHash: sha256Hex(token) }).where(eq(recipients.id, r.id));
    await appendEvent(tx, now, { envelopeId, type: "recipient.notified", actor: "system", payload: { recipientId: r.id, email: r.email } });
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

/**
 * `placeholderTitles` are the titles a draft is created with before the sender
 * names it (the editor passes them): sending one of them is refused.
 */
export async function sendEnvelope(
  s: Services,
  ownerId: string,
  envelopeId: string,
  meta: RequestMeta = {},
  opts: { placeholderTitles?: readonly string[] } = {},
) {
  const now = s.now();
  const mails = await s.db.transaction(async (tx) => {
    const env = await ownedEnvelopeForUpdate(tx, ownerId, envelopeId);
    requireDraft(env);
    const problems: string[] = [];
    if (opts.placeholderTitles?.includes(env.title)) problems.push("placeholder_title");
    if (!env.documentSha256) problems.push("no_document");
    const list = await tx.select().from(recipients).where(eq(recipients.envelopeId, envelopeId));
    const actors = list.filter((r) => r.role !== "viewer");
    if (actors.length === 0) problems.push("no_signer");
    const placedRows = await tx.select({ r: fields.recipientId }).from(fields).where(eq(fields.envelopeId, envelopeId));
    const placed = new Set(placedRows.map((f) => f.r));
    const withoutField = list.filter((r) => r.role === "signer" && !placed.has(r.id)).map((r) => r.id);
    if (withoutField.length) problems.push("signer_without_field");
    if (problems.length) throw new DomainError("invalid_state", "Not ready to send", { problems, recipients: withoutField });

    await tx.update(envelopes).set({ status: "in_progress", sentAt: now, updatedAt: now }).where(eq(envelopes.id, envelopeId));
    await appendEvent(tx, now, {
      envelopeId,
      type: "envelope.sent",
      actor: owner(ownerId),
      ...meta,
      payload: { documentSha256: env.documentSha256, recipients: list.length },
    });
    return (await advanceRouting(tx, s, envelopeId, now)).mails;
  });
  await deliver(s, mails);
  return getEnvelope(s, ownerId, envelopeId);
}

/** Issues a fresh link for a recipient whose turn it is (the old link stops working). */
export async function resendInvitation(s: Services, ownerId: string, envelopeId: string, recipientId: string, meta: RequestMeta = {}) {
  const now = s.now();
  const mail = await s.db.transaction(async (tx) => {
    const env = await ownedEnvelopeForUpdate(tx, ownerId, envelopeId);
    if (env.status !== "in_progress") throw new DomainError("invalid_state");
    const [r] = await tx
      .select()
      .from(recipients)
      .where(and(eq(recipients.id, recipientId), eq(recipients.envelopeId, envelopeId)));
    if (!r) throw new DomainError("not_found");
    if (!ACTIVE.includes(r.status)) throw new DomainError("invalid_state", "Not this recipient's turn");
    const token = randomToken();
    await tx.update(recipients).set({ tokenHash: sha256Hex(token) }).where(eq(recipients.id, r.id));
    await appendEvent(tx, now, { envelopeId, type: "recipient.notified", actor: owner(ownerId), ...meta, payload: { recipientId: r.id, email: r.email, resent: true } });
    const [sender] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ownerId));
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
  const mails = await s.db.transaction(async (tx) => {
    const env = await ownedEnvelopeForUpdate(tx, ownerId, envelopeId);
    if (env.status !== "in_progress") throw new DomainError("invalid_state");
    // Once every signer and approver has acted the request is signed: it is
    // about to be sealed, and its sender can no longer withdraw it.
    const [pending] = await tx
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(eq(recipients.envelopeId, envelopeId), ne(recipients.role, "viewer"), notInArray(recipients.status, DONE)))
      .limit(1);
    if (!pending) return null;
    await tx.update(envelopes).set({ status: "cancelled", closedAt: now, updatedAt: now }).where(eq(envelopes.id, envelopeId));
    await appendEvent(tx, now, { envelopeId, type: "envelope.cancelled", actor: owner(ownerId), ...meta });
    const [sender] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ownerId));
    const active = await tx
      .select()
      .from(recipients)
      .where(and(eq(recipients.envelopeId, envelopeId), inArray(recipients.status, ACTIVE)));
    return active.map((r) =>
      cancelledMail({ to: r.email, locale: r.locale, brand: s.config.brand, name: r.name, title: env.title, senderName: sender.name }),
    );
  });
  if (mails === null) {
    await resumeSealing(s, envelopeId);
    throw new DomainError("invalid_state", "Everyone has signed: the request can no longer be cancelled");
  }
  await deliver(s, mails);
  return getEnvelope(s, ownerId, envelopeId);
}

/**
 * A request signed by everyone but still in progress is being sealed, or its
 * seal failed after the last signature. Since it can no longer be cancelled,
 * the refused cancellation tries the seal again: that is its way out. A seal
 * that fails again is logged, and the cancellation stays refused.
 */
async function resumeSealing(s: Services, envelopeId: string): Promise<void> {
  try {
    // Loaded on demand: completion.ts imports this module.
    const { finalizeEnvelope } = await import("./completion");
    await finalizeEnvelope(s, envelopeId);
  } catch (e) {
    console.error(`[envelopes] sealing ${envelopeId} failed again: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function deleteEnvelope(s: Services, ownerId: string, envelopeId: string, meta: RequestMeta = {}): Promise<void> {
  const now = s.now();
  await s.db.transaction(async (tx) => {
    requireDraft(await ownedEnvelopeForUpdate(tx, ownerId, envelopeId));
    await appendEvent(tx, now, { envelopeId, type: "envelope.deleted", actor: owner(ownerId), ...meta });
    await tx.delete(envelopes).where(eq(envelopes.id, envelopeId));
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Used by the proxy: true only when this owner owns this envelope. */
export async function ownsEnvelope(s: Services, ownerId: string, envelopeId: string): Promise<boolean> {
  const [row] = await s.db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.id, envelopeId), eq(envelopes.ownerId, ownerId)));
  return !!row;
}

export async function getEnvelope(s: Services, ownerId: string, envelopeId: string): Promise<EnvelopeView> {
  return toView(s.db, await ownedEnvelope(s.db, ownerId, envelopeId));
}

export async function toView(db: Db, env: typeof envelopes.$inferSelect): Promise<EnvelopeView> {
  const recips = await db.select().from(recipients).where(eq(recipients.envelopeId, env.id)).orderBy(asc(recipients.position));
  const flds = await db.select().from(fields).where(eq(fields.envelopeId, env.id)).orderBy(asc(fields.page), asc(fields.y));
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

export async function listEnvelopes(s: Services, ownerId: string, q: ListQuery = {}) {
  const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  const where: SQL[] = [eq(envelopes.ownerId, ownerId)];
  if (q.status && q.status !== "all") where.push(eq(envelopes.status, q.status));
  // Case-insensitive search. LIKE wildcards and the escape character are dropped
  // from the term (drizzle's ilike() has no ESCAPE clause).
  const term = q.query?.replace(/[%_\\]/g, "").trim();
  if (term) {
    const pattern = `%${term}%`;
    const matchingRecipients = s.db
      .select({ id: recipients.envelopeId })
      .from(recipients)
      .where(or(ilike(recipients.name, pattern), ilike(recipients.email, pattern)));
    where.push(or(ilike(envelopes.title, pattern), inArray(envelopes.id, matchingRecipients))!);
  }
  const condition = and(...where);
  const [{ n: total }] = await s.db.select({ n: count() }).from(envelopes).where(condition);
  const rows = await s.db
    .select()
    .from(envelopes)
    .where(condition)
    .orderBy(desc(envelopes.updatedAt), desc(envelopes.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const recips = rows.length
    ? await s.db
        .select({ envelopeId: recipients.envelopeId, name: recipients.name, status: recipients.status, role: recipients.role })
        .from(recipients)
        .where(inArray(recipients.envelopeId, rows.map((r) => r.id)))
        .orderBy(asc(recipients.position))
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

export async function ownerDocument(s: Services, ownerId: string, envelopeId: string, which: "original" | "final") {
  const env = await ownedEnvelope(s.db, ownerId, envelopeId);
  const sha = which === "final" ? env.finalSha256 : env.documentSha256;
  if (!sha) throw new DomainError("not_found");
  const base = (env.documentName ?? "document.pdf").replace(/\.pdf$/i, "");
  return { bytes: s.files.get(sha), fileName: which === "final" ? `${base} (signed).pdf` : `${base}.pdf` };
}
