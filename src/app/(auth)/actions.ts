"use server";

import { redirect } from "next/navigation";
import { signIn, signUp } from "@/server/auth";
import { actionError, currentLocale, requestMeta, services, setSessionCookie, type ActionState } from "@/server/request";

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
