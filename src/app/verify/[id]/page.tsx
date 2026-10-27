import type { Metadata } from "next";
import { Badge, Card, Notice, PageTitle } from "@/components/ui";
import { formatDate, getDictionary } from "@/i18n/dictionaries";
import { currentLocale, services } from "@/server/request";
import { publicEnvelope } from "@/server/verification";
import { VerifyForm } from "../verify-form";

export const metadata: Metadata = { title: "Vérifier · Verify" };

export default async function PublicEnvelopePage(props: PageProps<"/verify/[id]">) {
  const s = await services();
  const locale = await currentLocale();
  const t = getDictionary(locale);
  const { id } = await props.params;
  const env = publicEnvelope(s, id);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>{t.verify.publicTitle}</PageTitle>
      {env ? (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">{env.title}</h2>
          <p className="text-sm text-muted">
            {t.verify.completedOn} {formatDate(env.completedAt, locale)}
          </p>
          <ul className="space-y-1 text-sm">
            {env.participants.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-muted">{p.email}</span>
                <Badge status={p.status}>{t.status.recipient[p.status as keyof typeof t.status.recipient] ?? p.status}</Badge>
              </li>
            ))}
          </ul>
          <p className="break-all text-xs text-muted">
            {t.verify.sha256} : <span className="font-mono">{env.finalSha256}</span>
          </p>
        </Card>
      ) : (
        <Notice tone="error">{t.verify.notFound}</Notice>
      )}
      <Card className="space-y-3">
        <p className="text-sm text-muted">{t.verify.publicHint}</p>
        <VerifyForm t={t} locale={locale} />
      </Card>
    </div>
  );
}
