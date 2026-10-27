import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, userForSession } from "@/server/auth";
import { signingLinkExists } from "@/server/ceremony";
import { ownsEnvelope } from "@/server/envelopes";
import { getServices } from "@/server/services";

/**
 * Answers 404/redirects with a real HTTP status before rendering. Pages stream
 * (Partial Prerendering), so a notFound() inside them can only render the
 * not-found UI with a 200 status. The pages keep their own checks: this is an
 * extra layer, not the authorisation itself.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const s = getServices();

  const signing = pathname.match(/^\/s\/([^/]+)(?:\/document)?$/);
  if (signing) {
    return signingLinkExists(s, decodeURIComponent(signing[1])) ? NextResponse.next() : notFound(request);
  }

  const owned = pathname.match(/^\/envelopes\/([0-9a-f-]{36})(\/document)?$/i);
  if (owned) {
    const user = userForSession(s, request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) {
      return owned[2] ? new NextResponse("Unauthorized", { status: 401 }) : NextResponse.redirect(new URL("/login", request.url));
    }
    return ownsEnvelope(s, user.id, owned[1].toLowerCase()) ? NextResponse.next() : notFound(request);
  }
  return NextResponse.next();
}

function notFound(request: NextRequest) {
  const fr = (request.headers.get("accept-language") ?? "").toLowerCase().startsWith("fr") || request.cookies.get("signsen_locale")?.value === "fr";
  const [title, text, home] = fr
    ? ["Lien introuvable", "Ce lien n'existe pas, a été remplacé par un plus récent, ou ne vous est pas destiné.", "Retour à l'accueil"]
    : ["Link not found", "This link does not exist, was replaced by a newer one, or is not meant for you.", "Back to home"];
  const html = `<!doctype html><html lang="${fr ? "fr" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1b1d1f"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p><p><a href="/">${home}</a></p></body></html>`;
  return new NextResponse(html, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export const config = {
  matcher: ["/s/:token", "/s/:token/document", "/envelopes/:id", "/envelopes/:id/document"],
};
