import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "./config";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "./crypto";
import { sessions, users } from "./db/schema";
import { DomainError } from "./errors";
import { consumeRate } from "./ratelimit";
import type { Services } from "./services";

export const SESSION_COOKIE = "signsen_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  locale: Locale;
}

const signUpSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  locale: z.enum(["fr", "en"]),
});

const toPublic = (u: typeof users.$inferSelect): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  locale: u.locale,
});

export async function signUp(s: Services, input: z.input<typeof signUpSchema>): Promise<PublicUser> {
  if (!s.config.allowSignup) throw new DomainError("signup_disabled");
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", undefined, { fields: fieldErrors(parsed.error) });
  const email = parsed.data.email.toLowerCase();
  if (s.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
    throw new DomainError("email_taken");
  }
  const row = {
    id: randomUUID(),
    email,
    name: parsed.data.name,
    passwordHash: await hashPassword(parsed.data.password),
    locale: parsed.data.locale,
    createdAt: s.now(),
  };
  s.db.insert(users).values(row).run();
  return toPublic(row);
}

export async function signIn(
  s: Services,
  input: { email: string; password: string },
  meta: { ip?: string | null } = {},
): Promise<{ user: PublicUser; token: string; expiresAt: number }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const now = s.now();
  const windowMs = 15 * 60 * 1000;
  const allowed =
    consumeRate(s.db, `signin:email:${email}`, 10, windowMs, now) &&
    (!meta.ip || consumeRate(s.db, `signin:ip:${meta.ip}`, s.config.signinIpLimit, windowMs, now));
  if (!allowed) throw new DomainError("rate_limited");

  const user = s.db.select().from(users).where(eq(users.email, email)).get();
  // Same work and same answer whether the account exists or not.
  const ok = user
    ? await verifyPassword(String(input.password ?? ""), user.passwordHash)
    : (await verifyPassword("x", await dummyHash()), false);
  if (!user || !ok) throw new DomainError("invalid_credentials");

  const token = randomToken();
  const expiresAt = now + SESSION_TTL_MS;
  s.db
    .insert(sessions)
    .values({ id: randomUUID(), userId: user.id, tokenHash: sha256Hex(token), createdAt: now, expiresAt })
    .run();
  return { user: toPublic(user), token, expiresAt };
}

// A real scrypt hash of a random password, so unknown e-mails cost the same time.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

export function userForSession(s: Services, token: string | undefined | null): PublicUser | null {
  if (!token) return null;
  const row = s.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, s.now())))
    .get();
  return row ? toPublic(row.user) : null;
}

export function signOut(s: Services, token: string | undefined | null) {
  if (token) s.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token))).run();
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    out[key] ??= issue.code;
  }
  return out;
}
