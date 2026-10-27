import { cookies } from "next/headers";
import { userForSession } from "@/server/auth";
import { ownerDocument } from "@/server/envelopes";
import { isDomainError } from "@/server/errors";
import { pdfResponse } from "@/server/http";
import { SESSION_COOKIE, services } from "@/server/request";

export async function GET(request: Request, ctx: RouteContext<"/envelopes/[id]/document">) {
  const s = await services();
  const user = userForSession(s, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const which = url.searchParams.get("which") === "final" ? "final" : "original";
  try {
    const doc = ownerDocument(s, user.id, id, which);
    return pdfResponse(doc.bytes, doc.fileName, url.searchParams.has("download"));
  } catch (e) {
    if (isDomainError(e, "not_found")) return new Response("Not found", { status: 404 });
    throw e;
  }
}
