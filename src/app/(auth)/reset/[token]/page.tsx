import type { Metadata } from "next";
import Link from "next/link";
import { Card, Notice } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { resetLinkValid } from "@/server/auth";
import { currentLocale, services } from "@/server/request";
import { ResetPasswordForm } from "../../password-forms";

export const metadata: Metadata = { title: "Nouveau mot de passe · New password", referrer: "no-referrer" };

export default async function ResetPasswordPage(props: PageProps<"/reset/[token]">) {
  const s = await services();
  const t = getDictionary(await currentLocale());
  const { token } = await props.params;
  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <h1 className="mb-4 text-xl font-semibold">{t.auth.resetTitle}</h1>
        {resetLinkValid(s, token) ? (
          <ResetPasswordForm token={token} t={t} />
        ) : (
          <div className="space-y-4">
            <Notice tone="error">{t.errors.reset_link_invalid}</Notice>
            <p className="text-center text-sm">
              <Link href="/forgot" className="font-medium text-brand underline-offset-2 hover:underline">
                {t.auth.requestNewLink}
              </Link>
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
