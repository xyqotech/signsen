import { sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { rateLimits } from "./db/schema";

/**
 * Fixed-window counter. Returns true when the action is allowed (and counts it),
 * false once `limit` actions already happened in the current window.
 *
 * One statement, so that concurrent requests on several connections cannot all
 * read the same count: the row is locked by the upsert, which either opens a
 * new window, counts one more, or changes nothing (and returns no row) when the
 * limit is reached.
 */
export async function consumeRate(db: Db, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const expired = sql`${now}::bigint - ${rateLimits.windowStart} >= ${windowMs}::bigint`;
  const counted = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`case when ${expired} then ${now}::bigint else ${rateLimits.windowStart} end`,
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
      },
      setWhere: sql`${expired} or ${rateLimits.count} < ${limit}::integer`,
    })
    .returning({ count: rateLimits.count });
  return counted.length === 1;
}
