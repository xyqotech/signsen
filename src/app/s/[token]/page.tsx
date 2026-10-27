import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CeremonyPanel } from "@/components/ceremony-panel";
import { Badge, buttonClass, Card, Notice } from "@/components/ui";
import { formatDate, getDictionary } from "@/i18n/dictionaries";
import { openCeremony, type CeremonyView } from "@/server/ceremony";
import { isDomainError } from "@/server/errors";
import { currentLocale, requestMeta, services } from "@/server/request";

export const metadata: Metadata = { title: "Signature", referrer: "no-referrer" };

export default async function CeremonyPage(props: PageProps<"/s/[token]">) {
  const s = await services();
  const locale = await currentLocale();
  const t = getDictionary(locale);
  const c = t.ceremony;
  const { token } = await props.params;
  let view: CeremonyView;
  try {
    view = openCeremony(s, token, await requestMeta());
  } catch (e) {
    if (isDomainError(e, "not_found")) notFound();
    throw e;
  }
  const { envelope, recipient } = view;

  let closed: { tone: "success" | "info" | "error"; text: string } | null = null;
  const thanks = recipient.status === "signed" ? c.doneSigned : recipient.status === "approved" ? c.doneApproved : "";
  if (envelope.status === "completed") closed = { tone: "success", text: thanks ? `${thanks} ${c.completed}` : c.completed };
  else if (envelope.status === "cancelled") closed = { tone: "info", text: c.closedCancelled };
  else if (envelope.status === "declined") closed = { tone: recipient.status === "declined" ? "info" : "error", text: recipient.status === "declined" ? c.doneDeclined : c.closedDeclined };
  else if (recipient.status === "signed") closed = { tone: "success", text: `${c.doneSigned} ${c.waitingOthers}` };
  else if (recipient.status === "approved") closed = { tone: "success", text: `${c.doneApproved} ${c.waitingOthers}` };
  else if (!view.canAct) closed = { tone: "info", text: recipient.role === "viewer" ? c.waitingOthers : c.notYourTurn };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-muted">
          {c.hello} {recipient.name}, <strong className="text-foreground">{envelope.senderName}</strong> ({envelope.senderEmail}) {c.sentBy}.
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{envelope.title}</h1>
        <p className="text-sm text-muted">{envelope.documentName}</p>
        {envelope.message ? (
          <blockquote className="whitespace-pre-line rounded-lg border-l-4 border-brand bg-surface px-4 py-3 text-sm">
            <span className="mb-1 block text-xs text-muted">
              {c.messageFrom} {envelope.senderName}
            </span>
            {envelope.message}
          </blockquote>
        ) : null}
      </header>

      {closed ? (
        <Card className="space-y-4">
          <Notice tone={closed.tone}>{closed.text}</Notice>
          {recipient.status === "declined" && recipient.declineReason ? (
            <p className="text-sm text-muted">{recipient.declineReason}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <a href={`/s/${token}/document?download`} className={buttonClass(view.finalAvailable ? "primary" : "secondary")} data-testid="ceremony-download">
              {view.finalAvailable ? c.downloadFinal : c.downloadDocument}
            </a>
          </div>
          {envelope.completedAt ? <p className="text-xs text-muted">{formatDate(envelope.completedAt, locale)}</p> : null}
          <ul className="space-y-1 text-sm">
            {view.participants.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                <span>{p.name}</span>
                <Badge status={p.status}>{t.status.recipient[p.status]}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <CeremonyPanel token={token} view={view} t={t} />
      )}
    </div>
  );
}
