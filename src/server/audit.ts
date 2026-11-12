import { asc, desc, eq } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "./crypto";
import type { Db, Tx } from "./db/client";
import { lockEnvelope } from "./db/locks";
import { events } from "./db/schema";

export const GENESIS_HASH = "0".repeat(64);

export type EventType =
  | "envelope.created"
  | "envelope.updated"
  | "document.attached"
  | "recipient.added"
  | "recipient.removed"
  | "fields.updated"
  | "envelope.sent"
  | "recipient.notified"
  | "recipient.viewed"
  | "otp.sent"
  | "otp.failed"
  | "recipient.signed"
  | "recipient.approved"
  | "recipient.declined"
  | "envelope.completed"
  | "envelope.sealed"
  | "envelope.cancelled"
  | "envelope.deleted";

export interface EventInput {
  envelopeId: string;
  type: EventType;
  /** "owner:<userId>", "recipient:<recipientId>" or "system". */
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function eventHash(prevHash: string, e: Required<Omit<EventInput, "ip" | "userAgent">> & { ip: string | null; userAgent: string | null; createdAt: number }) {
  return sha256Hex(
    prevHash +
      canonicalJson({
        envelopeId: e.envelopeId,
        type: e.type,
        actor: e.actor,
        ip: e.ip,
        userAgent: e.userAgent,
        payload: e.payload,
        createdAt: e.createdAt,
      }),
  );
}

/**
 * Appends one event to the envelope's chain, inside the caller's transaction.
 *
 * "Read the last hash, then insert" is only safe one writer at a time: the
 * envelope's lock is taken first and held until the transaction ends, so a
 * concurrent writer waits and then reads the hash written here. Should that
 * ever be bypassed, the unique (envelope_id, prev_hash) constraint refuses the
 * second successor instead of letting the chain fork.
 */
export async function appendEvent(tx: Tx, createdAt: number, input: EventInput): Promise<{ id: number; hash: string }> {
  await lockEnvelope(tx, input.envelopeId);
  const [last] = await tx
    .select({ hash: events.hash })
    .from(events)
    .where(eq(events.envelopeId, input.envelopeId))
    .orderBy(desc(events.id))
    .limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  const record = {
    envelopeId: input.envelopeId,
    type: input.type,
    actor: input.actor,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 400) : null,
    payload: input.payload ?? {},
    createdAt,
  };
  const hash = eventHash(prevHash, record);
  const [row] = await tx
    .insert(events)
    .values({ ...record, payload: canonicalJson(record.payload), prevHash, hash })
    .returning({ id: events.id });
  return { id: row.id, hash };
}

export type ChainCheck = { ok: true; count: number; lastHash: string } | { ok: false; brokenAtEventId: number };

/** Recomputes every hash of the envelope's chain. */
export async function verifyChain(db: Db, envelopeId: string): Promise<ChainCheck> {
  const rows = await db.select().from(events).where(eq(events.envelopeId, envelopeId)).orderBy(asc(events.id));
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const expected = eventHash(prev, {
      envelopeId: row.envelopeId,
      type: row.type as EventType,
      actor: row.actor,
      ip: row.ip,
      userAgent: row.userAgent,
      payload: JSON.parse(row.payload),
      createdAt: row.createdAt,
    });
    if (row.prevHash !== prev || row.hash !== expected) return { ok: false, brokenAtEventId: row.id };
    prev = row.hash;
  }
  return { ok: true, count: rows.length, lastHash: prev };
}

export async function listEvents(db: Db, envelopeId: string) {
  const rows = await db.select().from(events).where(eq(events.envelopeId, envelopeId)).orderBy(asc(events.id));
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}
