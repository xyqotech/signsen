import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "./config";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "./crypto";
import { passwordResets, sessions, users } from "./db/schema";
import { DomainError } from "./errors";
import type { MailMessage } from "./mail";
import { passwordChangedMail, passwordResetMail } from "./notifications";
import { consumeRate } from "./ratelimit";
import type { Services } from "./services";

export const SESSION_COOKIE = "signsen_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const MIN_PASSWORD_LENGTH = 10;
export const RESET_TTL_MS = 3600 * 1000;
const RESETS_PER_HOUR = 3;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  locale: Locale;
}

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);

const signUpSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
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

/**
 * Mails a single-use link to choose a new password. The answer is the same
 * whether the account exists or not; a new link replaces the previous one.
 */
export async function requestPasswordReset(
  s: Services,
  input: { email: string },
  meta: { ip?: string | null } = {},
): Promise<void> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const now = s.now();
  const hourMs = 3600 * 1000;
  const allowed =
    consumeRate(s.db, `reset:email:${email}`, RESETS_PER_HOUR, hourMs, now) &&
    (!meta.ip || consumeRate(s.db, `reset:ip:${meta.ip}`, s.config.signinIpLimit, hourMs, now));
  if (!allowed) throw new DomainError("rate_limited");

  const user = s.db.select().from(users).where(eq(users.email, email)).get();
  if (!user) return;
  const token = randomToken();
  s.db.transaction((tx) => {
    tx.delete(passwordResets).where(eq(passwordResets.userId, user.id)).run();
    tx.insert(passwordResets)
      .values({ id: randomUUID(), userId: user.id, tokenHash: sha256Hex(token), createdAt: now, expiresAt: now + RESET_TTL_MS })
      .run();
  });
  sendInBackground(
    s,
    passwordResetMail({ to: user.email, locale: user.locale, brand: s.config.brand, name: user.name, link: `${s.config.appUrl}/reset/${token}` }),
  );
}

function findReset(s: Services, token: string | undefined | null) {
  if (!token) return undefined;
  return s.db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, sha256Hex(token)), gt(passwordResets.expiresAt, s.now())))
    .get();
}

export function resetLinkValid(s: Services, token: string | undefined | null): boolean {
  return findReset(s, token) !== undefined;
}

/** Sets the new password, spends the link and closes every session of the account. */
export async function resetPassword(s: Services, input: { token: string; password: string }): Promise<void> {
  const reset = findReset(s, input.token);
  if (!reset) throw new DomainError("reset_link_invalid");
  const parsed = z.object({ password: passwordSchema }).safeParse({ password: input.password });
  if (!parsed.success) throw new DomainError("validation", undefined, { fields: fieldErrors(parsed.error) });
  const passwordHash = await hashPassword(parsed.data.password);

  // Spent atomically: of two submissions racing with the same link, one wins.
  const user = s.db.transaction((tx) => {
    const spent = tx
      .delete(passwordResets)
      .where(and(eq(passwordResets.id, reset.id), gt(passwordResets.expiresAt, s.now())))
      .run();
    if (spent.changes !== 1) return undefined;
    tx.delete(passwordResets).where(eq(passwordResets.userId, reset.userId)).run();
    tx.update(users).set({ passwordHash }).where(eq(users.id, reset.userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, reset.userId)).run();
    return tx.select().from(users).where(eq(users.id, reset.userId)).get();
  });
  if (!user) throw new DomainError("reset_link_invalid");
  sendInBackground(
    s,
    passwordChangedMail({ to: user.email, locale: user.locale, brand: s.config.brand, name: user.name, forgotLink: `${s.config.appUrl}/forgot` }),
  );
}

/**
 * Not awaited: waiting for the mail server would make a request for an existing
 * account measurably slower than one for an unknown address.
 */
function sendInBackground(s: Services, mail: MailMessage) {
  s.mailer.send(mail).catch((e) => console.error(`Could not send "${mail.subject}"`, e));
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    out[key] ??= issue.code;
  }
  return out;
}
