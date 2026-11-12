import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { services } from "@/server/request";

const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/**
 * Health check for the container and for monitoring: 200 only when the
 * configuration is valid and PostgreSQL answers. Pages stream, so their status
 * stays 200 even when the database is unreachable; this answer does not.
 */
export async function GET() {
  // Request-time only. Kept out of the try: at build time Next ends the
  // prerender by rejecting this call, which must not be reported as an outage.
  await connection();
  try {
    const s = await services();
    await s.db.execute(sql`select 1`);
    return new Response("ok\n", { headers });
  } catch (e) {
    console.error(`[health] ${e instanceof Error ? e.message : String(e)}`);
    return new Response("unavailable\n", { status: 503, headers });
  }
}
