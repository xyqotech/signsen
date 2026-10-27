import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/form-bits";
import { Badge, buttonClass, Card, inputClass, PageTitle } from "@/components/ui";
import { formatDate, getDictionary } from "@/i18n/dictionaries";
import { ENVELOPE_STATUSES, type EnvelopeStatus } from "@/server/db/schema";
import { listEnvelopes } from "@/server/envelopes";
import { currentLocale, requireUser, services } from "@/server/request";
import { createEnvelopeAction } from "./actions";

export const metadata: Metadata = { title: "Mes demandes · My requests" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Dashboard(props: PageProps<"/envelopes">) {
  const user = await requireUser();
  const s = await services();
  const locale = await currentLocale();
  const t = getDictionary(locale);
  const sp = await props.searchParams;
  const rawStatus = one(sp.status);
  const status = (ENVELOPE_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as EnvelopeStatus) : "all";
  const query = (one(sp.q) ?? "").slice(0, 100);
  const page = Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1);
  const list = listEnvelopes(s, user.id, { status, query, page, pageSize: 15 });

  const href = (p: { status?: string; q?: string; page?: number }) => {
    const params = new URLSearchParams();
    const st = p.status ?? status;
    if (st !== "all") params.set("status", st);
    const q = p.q ?? query;
    if (q) params.set("q", q);
    if ((p.page ?? 1) > 1) params.set("page", String(p.page));
    const qs = params.toString();
    return qs ? `/envelopes?${qs}` : "/envelopes";
  };

  return (
    <div>
      <PageTitle
        aside={
          <form action={createEnvelopeAction}>
            <SubmitButton>+ {t.dashboard.newEnvelope}</SubmitButton>
          </form>
        }
      >
        {t.dashboard.title}
      </PageTitle>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav aria-label={t.dashboard.title} className="flex flex-wrap gap-1">
          {(["all", ...ENVELOPE_STATUSES] as const).map((st) => (
            <Link
              key={st}
              href={href({ status: st, page: 1 })}
              aria-current={st === status ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm ${st === status ? "bg-brand text-brand-ink" : "bg-surface text-muted hover:text-foreground"} border border-line`}
            >
              {t.dashboard.filters[st]}
            </Link>
          ))}
        </nav>
        <form action="/envelopes" className="ml-auto flex w-full gap-2 sm:w-80" role="search">
          {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
          <input name="q" defaultValue={query} placeholder={t.dashboard.search} aria-label={t.dashboard.search} className={inputClass} />
        </form>
      </div>

      {list.items.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="font-medium">{t.dashboard.empty}</p>
          <p className="mt-1 text-sm text-muted">{t.dashboard.emptyHint}</p>
        </Card>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" data-testid="envelope-list">
          {list.items.map((e) => (
            <li key={e.id}>
              <Link href={`/envelopes/${e.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 hover:bg-background">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{e.title}</p>
                  <p className="truncate text-sm text-muted">
                    {e.recipients.length ? e.recipients.map((r) => r.name).join(", ") : t.dashboard.noRecipients}
                  </p>
                </div>
                <span className="text-xs text-muted">
                  {t.dashboard.updated} {formatDate(e.updatedAt, locale)}
                </span>
                <Badge status={e.status}>{t.status.envelope[e.status]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="pagination">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className={buttonClass("secondary")}>
              ← {t.common.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            {t.common.page} {list.page} {t.common.of} {list.pages}
          </span>
          {page < list.pages ? (
            <Link href={href({ page: page + 1 })} className={buttonClass("secondary")}>
              {t.common.next} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
