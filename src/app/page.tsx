import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonClass, Card } from "@/components/ui";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale, currentUser, services } from "@/server/request";

export default async function Home() {
  if (await currentUser()) redirect("/envelopes");
  const s = await services();
  const t = getDictionary(await currentLocale());
  return (
    <div className="space-y-10">
      <section className="max-w-3xl space-y-4 pt-6">
        <p className="text-sm font-medium text-brand">{s.config.brand.name}</p>
        <h1 className="text-4xl font-semibold tracking-tight">{t.home.title}</h1>
        <p className="text-lg text-muted">{t.home.subtitle}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          {s.config.allowSignup ? (
            <Link href="/signup" className={buttonClass("primary")}>
              {t.home.start}
            </Link>
          ) : null}
          <Link href="/login" className={buttonClass("secondary")}>
            {t.common.signIn}
          </Link>
          <Link href="/verify" className={buttonClass("ghost")}>
            {t.common.verifyDocument}
          </Link>
        </div>
      </section>
      <div className="grid gap-4 md:grid-cols-3">
        {t.home.features.map((f) => (
          <Card key={f.title}>
            <h2 className="mb-1 font-semibold">{f.title}</h2>
            <p className="text-sm text-muted">{f.text}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
