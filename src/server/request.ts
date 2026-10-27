import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { RequestMeta } from "./audit";
import { SESSION_COOKIE, userForSession, type PublicUser } from "./auth";
import { SUPPORTED_LOCALES, type Locale } from "./config";
import { isDomainError, type ErrorCode } from "./errors";
import { getServices, type Services } from "./services";

export { SESSION_COOKIE };
export const LOCALE_COOKIE = "signsen_locale";

/**
 * Entry point for every page, action and route handler. `connection()` marks the
 * render as request-time: the database is synchronous (better-sqlite3), so
 * without it Next would run queries at build time and freeze their result.
 */
export async function services(): Promise<Services> {
  await connection();
  return getServices();
}

export async function currentUser(): Promise<PublicUser | null> {
  const s = await services();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return userForSession(s, token);
}

export async function requireUser(): Promise<PublicUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function currentLocale(): Promise<Locale> {
  const s = await services();
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (fromCookie && (SUPPORTED_LOCALES as readonly string[]).includes(fromCookie)) return fromCookie as Locale;
  const accept = (await headers()).get("accept-language") ?? "";
  for (const part of accept.split(",")) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if ((SUPPORTED_LOCALES as readonly string[]).includes(tag)) return tag as Locale;
  }
  return s.config.defaultLocale;
}

/**
 * Client IP for the evidence file. SignSen is meant to run behind a reverse proxy
 * that sets X-Forwarded-For; the right-most entry is the one that proxy wrote,
 * so a client cannot forge it by sending its own header.
 */
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",").map((p) => p.trim()).filter(Boolean).pop() ?? null : h.get("x-real-ip");
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: h.get("user-agent") };
}

export async function setSessionCookie(token: string, expiresAt: number) {
  const s = await services();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: s.config.appUrl.startsWith("https://"),
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export type ActionState = { ok: boolean; error?: ErrorCode | "generic"; fields?: Record<string, string>; details?: Record<string, unknown>; message?: string };

/** Turns a thrown error into a state the form can display; unexpected errors are logged. */
export function actionError(e: unknown): ActionState {
  if (isDomainError(e)) {
    const fields = (e.details?.fields as Record<string, string> | undefined) ?? undefined;
    return { ok: false, error: e.code, fields, details: e.details };
  }
  // redirect() and notFound() work by throwing: let them through.
  if (e && typeof e === "object" && "digest" in e && typeof (e as { digest: unknown }).digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_")) {
    throw e;
  }
  console.error(e);
  return { ok: false, error: "generic" };
}
