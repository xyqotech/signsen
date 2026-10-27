import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Notice } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale, currentUser, services } from "@/server/request";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Inscription · Sign up" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/envelopes");
  const s = await services();
  const t = getDictionary(await currentLocale());
  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-4 text-xl font-semibold">{t.auth.signupTitle}</h1>
        {s.config.allowSignup ? <AuthForm mode="signup" t={t} /> : <Notice tone="info">{t.errors.signup_disabled}</Notice>}
        <p className="mt-4 text-center text-sm text-muted">
          {t.auth.haveAccount}{" "}
          <Link href="/login" className="font-medium text-brand underline-offset-2 hover:underline">
            {t.common.signIn}
          </Link>
        </p>
      </Card>
    </div>
  );
}
