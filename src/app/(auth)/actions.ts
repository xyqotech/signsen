"use server";

import { redirect } from "next/navigation";
import { requestPasswordReset, resetPassword, signIn, signUp } from "@/server/auth";
import {
  actionError,
  clearSessionCookie,
  currentLocale,
  requestMeta,
  services,
  setSessionCookie,
  type ActionState,
} from "@/server/request";

export async function loginAction(_prev: unknown, formData: FormData): Promise<ActionState> {
  const s = await services();
  try {
    const { token, expiresAt } = await signIn(
      s,
      { email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? "") },
      await requestMeta(),
    );
    await setSessionCookie(token, expiresAt);
  } catch (e) {
    return actionError(e);
  }
  redirect("/envelopes");
}

export async function signupAction(_prev: unknown, formData: FormData): Promise<ActionState> {
  const s = await services();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signUp(s, { email, password, name: String(formData.get("name") ?? ""), locale: await currentLocale() });
    const { token, expiresAt } = await signIn(s, { email, password }, await requestMeta());
    await setSessionCookie(token, expiresAt);
  } catch (e) {
    return actionError(e);
  }
  redirect("/envelopes");
}

export async function forgotPasswordAction(_prev: unknown, formData: FormData): Promise<ActionState> {
  const s = await services();
  try {
    await requestPasswordReset(s, { email: String(formData.get("email") ?? "") }, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  return { ok: true };
}

export async function resetPasswordAction(_prev: unknown, formData: FormData): Promise<ActionState> {
  const s = await services();
  try {
    await resetPassword(s, { token: String(formData.get("token") ?? ""), password: String(formData.get("password") ?? "") });
  } catch (e) {
    return actionError(e);
  }
  // Every session of the account was just closed, this browser's included. The
  // link is spent: leave its page, which would now only say so.
  await clearSessionCookie();
  redirect("/login?reset=done");
}
