import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale } from "@/server/request";
import { ForgotPasswordForm } from "../password-forms";

export const metadata: Metadata = { title: "Mot de passe oublié · Forgot password" };

export default async function ForgotPasswordPage() {
  const t = getDictionary(await currentLocale());
  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-4 text-xl font-semibold">{t.auth.forgotTitle}</h1>
        <ForgotPasswordForm t={t} />
        <p className="mt-4 text-center text-sm">
          <Link href="/login" className="font-medium text-brand underline-offset-2 hover:underline">
            {t.auth.backToLogin}
          </Link>
        </p>
      </Card>
    </div>
  );
}
