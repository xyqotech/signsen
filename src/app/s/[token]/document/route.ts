import { ceremonyDocument } from "@/server/ceremony";
import { isDomainError } from "@/server/errors";
import { pdfResponse } from "@/server/http";
import { services } from "@/server/request";

export async function GET(request: Request, ctx: RouteContext<"/s/[token]/document">) {
  const s = await services();
  const { token } = await ctx.params;
  try {
    const doc = ceremonyDocument(s, token);
    return pdfResponse(doc.bytes, doc.fileName, new URL(request.url).searchParams.has("download"));
  } catch (e) {
    if (isDomainError(e, "not_found")) return new Response("Not found", { status: 404 });
    throw e;
  }
}
