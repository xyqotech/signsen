import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale, currentUser, services } from "@/server/request";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Connexion · Sign in" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/envelopes");
  const s = await services();
  const t = getDictionary(await currentLocale());
  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-4 text-xl font-semibold">{t.auth.loginTitle}</h1>
        <AuthForm mode="login" t={t} />
        {s.config.allowSignup ? (
          <p className="mt-4 text-center text-sm text-muted">
            {t.auth.noAccount}{" "}
            <Link href="/signup" className="font-medium text-brand underline-offset-2 hover:underline">
              {t.common.signUp}
            </Link>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
