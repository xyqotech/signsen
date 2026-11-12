import { sql } from "drizzle-orm";
import type { Tx } from "./client";

/**
 * Serialises the writers of one envelope: waits until no other transaction
 * holds this envelope's lock, then holds it until commit or rollback.
 *
 * Take it first, before reading what the transaction is about to check. Under
 * PostgreSQL's default isolation (read committed) every statement that follows
 * sees what the previous holder committed, so "read, check, write" stays
 * correct with any number of connections. Taking it again in the same
 * transaction is free, and it works for an envelope whose row does not exist
 * (a draft being created or deleted), which a row lock would not.
 */
export async function lockEnvelope(tx: Tx, envelopeId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`envelope:${envelopeId}`}, 0))`);
}
