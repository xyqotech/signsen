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
  const [taken] = await s.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (taken) throw new DomainError("email_taken");
  const row = {
    id: randomUUID(),
    email,
    name: parsed.data.name,
    passwordHash: await hashPassword(parsed.data.password),
    locale: parsed.data.locale,
    createdAt: s.now(),
  };
  // Two sign-ups racing with the same address: the unique e-mail decides, one wins.
  const created = await s.db.insert(users).values(row).onConflictDoNothing({ target: users.email }).returning({ id: users.id });
  if (created.length === 0) throw new DomainError("email_taken");
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
    (await consumeRate(s.db, `signin:email:${email}`, 10, windowMs, now)) &&
    (!meta.ip || (await consumeRate(s.db, `signin:ip:${meta.ip}`, s.config.signinIpLimit, windowMs, now)));
  if (!allowed) throw new DomainError("rate_limited");

  const [user] = await s.db.select().from(users).where(eq(users.email, email));
  // Same work and same answer whether the account exists or not.
  const ok = user
    ? await verifyPassword(String(input.password ?? ""), user.passwordHash)
    : (await verifyPassword("x", await dummyHash()), false);
  if (!user || !ok) throw new DomainError("invalid_credentials");

  const token = randomToken();
  const expiresAt = now + SESSION_TTL_MS;
  await s.db.insert(sessions).values({ id: randomUUID(), userId: user.id, tokenHash: sha256Hex(token), createdAt: now, expiresAt });
  return { user: toPublic(user), token, expiresAt };
}

// A real scrypt hash of a random password, so unknown e-mails cost the same time.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

export async function userForSession(s: Services, token: string | undefined | null): Promise<PublicUser | null> {
  if (!token) return null;
  const [row] = await s.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, s.now())));
  return row ? toPublic(row.user) : null;
}

export async function signOut(s: Services, token: string | undefined | null): Promise<void> {
  if (token) await s.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
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
    (await consumeRate(s.db, `reset:email:${email}`, RESETS_PER_HOUR, hourMs, now)) &&
    (!meta.ip || (await consumeRate(s.db, `reset:ip:${meta.ip}`, s.config.signinIpLimit, hourMs, now)));
  if (!allowed) throw new DomainError("rate_limited");

  const [user] = await s.db.select().from(users).where(eq(users.email, email));
  const token = randomToken();
  // The same statements run for an unknown address (on an id that matches
  // nothing), so the database round trips do not tell the two cases apart.
  const userId = user?.id ?? randomUUID();
  await s.db.transaction(async (tx) => {
    // Requests for one account queue on its row: the latest link is the only one left.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
    if (!user) return;
    await tx
      .insert(passwordResets)
      .values({ id: randomUUID(), userId, tokenHash: sha256Hex(token), createdAt: now, expiresAt: now + RESET_TTL_MS });
  });
  if (!user) return;
  sendInBackground(
    s,
    passwordResetMail({ to: user.email, locale: user.locale, brand: s.config.brand, name: user.name, link: `${s.config.appUrl}/reset/${token}` }),
  );
}

async function findReset(s: Services, token: string | undefined | null) {
  if (!token) return undefined;
  const [reset] = await s.db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, sha256Hex(token)), gt(passwordResets.expiresAt, s.now())));
  return reset;
}

export async function resetLinkValid(s: Services, token: string | undefined | null): Promise<boolean> {
  return (await findReset(s, token)) !== undefined;
}

/** Sets the new password, spends the link and closes every session of the account. */
export async function resetPassword(s: Services, input: { token: string; password: string }): Promise<void> {
  const reset = await findReset(s, input.token);
  if (!reset) throw new DomainError("reset_link_invalid");
  const parsed = z.object({ password: passwordSchema }).safeParse({ password: input.password });
  if (!parsed.success) throw new DomainError("validation", undefined, { fields: fieldErrors(parsed.error) });
  const passwordHash = await hashPassword(parsed.data.password);

  // Spent atomically: of two submissions racing with the same link, one deletes
  // the row and the other, once unblocked, finds nothing left to delete.
  const user = await s.db.transaction(async (tx) => {
    const spent = await tx
      .delete(passwordResets)
      .where(and(eq(passwordResets.id, reset.id), gt(passwordResets.expiresAt, s.now())))
      .returning({ id: passwordResets.id });
    if (spent.length !== 1) return undefined;
    await tx.delete(passwordResets).where(eq(passwordResets.userId, reset.userId));
    await tx.update(users).set({ passwordHash }).where(eq(users.id, reset.userId));
    await tx.delete(sessions).where(eq(sessions.userId, reset.userId));
    const [row] = await tx.select().from(users).where(eq(users.id, reset.userId));
    return row;
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
