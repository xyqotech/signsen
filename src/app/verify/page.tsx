import type { Metadata } from "next";
import { Card, PageTitle } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale } from "@/server/request";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Vérifier · Verify" };

export default async function VerifyPage() {
  const locale = await currentLocale();
  const t = getDictionary(locale);
  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle>{t.verify.title}</PageTitle>
      <Card className="space-y-4">
        <p className="text-sm text-muted">{t.verify.intro}</p>
        <VerifyForm t={t} locale={locale} />
      </Card>
    </div>
  );
}
