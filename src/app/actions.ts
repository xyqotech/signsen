"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/server/auth";
import { SUPPORTED_LOCALES } from "@/server/config";
import { clearSessionCookie, LOCALE_COOKIE, SESSION_COOKIE, services } from "@/server/request";

export async function setLocaleAction(formData: FormData) {
  const locale = String(formData.get("locale") ?? "");
  if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", sameSite: "lax", maxAge: 365 * 24 * 3600 });
  }
}

export async function signOutAction() {
  const s = await services();
  signOut(s, (await cookies()).get(SESSION_COOKIE)?.value);
  await clearSessionCookie();
  redirect("/login");
}
