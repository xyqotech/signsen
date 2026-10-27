import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { FieldEditor } from "@/components/field-editor";
import { SubmitButton } from "@/components/form-bits";
import { Badge, buttonClass, Card, inputClass, Label, PageTitle } from "@/components/ui";
import { formatDate, getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { listEvents } from "@/server/audit";
import type { Locale } from "@/server/config";
import { getEnvelope, type EnvelopeView } from "@/server/envelopes";
import { isDomainError } from "@/server/errors";
import { currentLocale, requireUser, services } from "@/server/request";
import {
  addRecipientAction,
  cancelAction,
  deleteAction,
  removeRecipientAction,
  resendAction,
  sendAction,
  updateDetailsAction,
  uploadDocumentAction,
} from "../actions";

export const metadata: Metadata = { title: "Demande · Request" };

export default async function EnvelopePage(props: PageProps<"/envelopes/[id]">) {
  const user = await requireUser();
  const s = await services();
  const locale = await currentLocale();
  const t = getDictionary(locale);
  const { id } = await props.params;
  let env: EnvelopeView;
  try {
    env = getEnvelope(s, user.id, id);
  } catch (e) {
    if (isDomainError(e, "not_found")) notFound();
    throw e;
  }
  return (
    <div>
      <p className="mb-2 text-sm">
        <Link href="/envelopes" className="text-muted hover:text-foreground">
          ← {t.dashboard.title}
        </Link>
      </p>
      <PageTitle aside={<Badge status={env.status}>{t.status.envelope[env.status]}</Badge>}>{env.title}</PageTitle>
      {env.status === "draft" ? <Draft env={env} t={t} /> : <Tracking env={env} t={t} locale={locale} events={listEvents(s.db, env.id)} />}
    </div>
  );
}

function Draft({ env, t }: { env: EnvelopeView; t: Dictionary }) {
  const signers = env.recipients.filter((r) => r.role === "signer");
  const docUrl = `/envelopes/${env.id}/document`;
  return (
    <div className="space-y-6">
      <Card>
        <h2 className="mb-3 font-semibold">{t.editor.details}</h2>
        <ActionForm action={updateDetailsAction.bind(null, env.id)} errors={t.errors} successMessage="✓">
          <div>
            <Label htmlFor="title">{t.editor.title}</Label>
            <input id="title" name="title" defaultValue={env.title} required maxLength={200} className={inputClass} />
          </div>
          <div>
            <Label htmlFor="message">{t.editor.message}</Label>
            <textarea id="message" name="message" defaultValue={env.message ?? ""} maxLength={2000} rows={3} className={inputClass} />
          </div>
          <SubmitButton variant="secondary">{t.common.save}</SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t.editor.document}</h2>
        {env.documentName ? (
          <p className="mb-3 text-sm">
            <a href={docUrl} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
              {env.documentName}
            </a>{" "}
            <span className="text-muted">
              · {env.pageCount} {t.editor.pages}
            </span>
          </p>
        ) : null}
        <ActionForm action={uploadDocumentAction.bind(null, env.id)} errors={t.errors} resetOnSuccess>
          <div>
            <Label htmlFor="document" hint={env.documentName ? t.editor.replaceWarning : t.editor.uploadHint}>
              {env.documentName ? t.editor.replace : t.editor.upload}
            </Label>
            <input id="document" name="document" type="file" accept="application/pdf,.pdf" required className="block text-sm" />
          </div>
          <SubmitButton variant="secondary">{env.documentName ? t.editor.replaceSubmit : t.editor.uploadSubmit}</SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t.editor.recipients}</h2>
        {env.recipients.length === 0 ? <p className="mb-3 text-sm text-muted">{t.editor.noRecipients}</p> : null}
        <ul className="mb-4 divide-y divide-line" data-testid="recipient-list">
          {env.recipients.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-background text-xs font-semibold" title={t.editor.order}>
                {r.routingOrder}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.name}</span> <span className="text-muted">{r.email}</span>
              </span>
              <span className="text-muted">{t.status.role[r.role]}</span>
              <form action={removeRecipientAction.bind(null, env.id, r.id)}>
                <SubmitButton variant="ghost">{t.editor.remove}</SubmitButton>
              </form>
            </li>
          ))}
        </ul>
        <ActionForm action={addRecipientAction.bind(null, env.id)} errors={t.errors} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end">
          <div>
            <Label htmlFor="r-name">{t.common.name}</Label>
            <input id="r-name" name="name" required maxLength={100} className={inputClass} />
          </div>
          <div>
            <Label htmlFor="r-email">{t.common.email}</Label>
            <input id="r-email" name="email" type="email" required maxLength={254} className={inputClass} />
          </div>
          <div>
            <Label htmlFor="r-role">{t.editor.role}</Label>
            <select id="r-role" name="role" defaultValue="signer" className={inputClass}>
              <option value="signer">{t.status.role.signer}</option>
              <option value="approver">{t.status.role.approver}</option>
              <option value="viewer">{t.status.role.viewer}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="r-order">{t.editor.order}</Label>
            <input
              id="r-order"
              name="routingOrder"
              type="number"
              min={1}
              max={25}
              defaultValue={Math.max(1, ...env.recipients.map((r) => r.routingOrder))}
              className={`${inputClass} w-20`}
            />
          </div>
          <SubmitButton>{t.editor.addRecipient}</SubmitButton>
        </ActionForm>
        <p className="mt-2 text-xs text-muted">{t.editor.orderHint}</p>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t.editor.fields}</h2>
        {env.documentName ? (
          <FieldEditor
            key={`${env.documentSha256}-${signers.map((s) => s.id).join(",")}`}
            envelopeId={env.id}
            documentUrl={`${docUrl}?v=${env.documentSha256}`}
            signers={signers.map((s) => ({ id: s.id, name: s.name }))}
            initial={env.fields}
            t={t}
          />
        ) : (
          <p className="text-sm text-muted">{t.errors.problems.no_document}</p>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold">{t.editor.review}</h2>
        <p className="mb-3 text-sm text-muted">{t.editor.sendHint}</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <ActionForm action={sendAction.bind(null, env.id)} errors={t.errors}>
            <SubmitButton>{t.editor.send}</SubmitButton>
          </ActionForm>
          <ActionForm action={deleteAction.bind(null, env.id)} errors={t.errors} confirmMessage={t.editor.deleteConfirm}>
            <SubmitButton variant="danger">{t.editor.deleteDraft}</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}

function Tracking({
  env,
  t,
  locale,
  events,
}: {
  env: EnvelopeView;
  t: Dictionary;
  locale: Locale;
  events: ReturnType<typeof listEvents>;
}) {
  const names = new Map(env.recipients.map((r) => [`recipient:${r.id}`, r.name]));
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-6">
        <Card>
          <h2 className="mb-3 font-semibold">{t.envelope.participants}</h2>
          <ul className="divide-y divide-line" data-testid="participants">
            {env.recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-background text-xs font-semibold">{r.routingOrder}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.name}</span> <span className="text-muted">{r.email}</span>
                  <span className="block text-xs text-muted">{t.status.role[r.role]}</span>
                  {r.declineReason ? (
                    <span className="mt-1 block rounded bg-red-50 px-2 py-1 text-xs text-red-900">
                      {t.envelope.reason} : {r.declineReason}
                    </span>
                  ) : null}
                </span>
                {r.actedAt ? <span className="text-xs text-muted">{formatDate(r.actedAt, locale)}</span> : null}
                <Badge status={r.status}>{t.status.recipient[r.status]}</Badge>
                {env.status === "in_progress" && (r.status === "notified" || r.status === "viewed") ? (
                  <ActionForm action={resendAction.bind(null, env.id, r.id)} errors={t.errors} successMessage={t.envelope.resent} className="flex items-center gap-2">
                    <SubmitButton variant="ghost">{t.envelope.resend}</SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">{t.envelope.history}</h2>
          <ol className="space-y-2 text-sm" data-testid="history">
            {events
              .filter((e) => !e.type.startsWith("otp.") || e.type === "otp.failed")
              .map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-3">
                  <span className="w-44 shrink-0 text-xs text-muted">{formatDate(e.createdAt, locale)}</span>
                  <span>
                    {t.envelope.events[e.type] ?? e.type}
                    {names.get(e.actor) ? <span className="text-muted"> — {names.get(e.actor)}</span> : null}
                    {e.type === "recipient.notified" && typeof e.payload.email === "string" ? (
                      <span className="text-muted"> — {e.payload.email}</span>
                    ) : null}
                  </span>
                </li>
              ))}
          </ol>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <dl className="space-y-2 text-sm">
            {env.sentAt ? (
              <div>
                <dt className="text-muted">{t.envelope.sentOn}</dt>
                <dd>{formatDate(env.sentAt, locale)}</dd>
              </div>
            ) : null}
            {env.completedAt ? (
              <div>
                <dt className="text-muted">{t.envelope.completedOn}</dt>
                <dd>{formatDate(env.completedAt, locale)}</dd>
              </div>
            ) : null}
            {env.finalSha256 ? (
              <div>
                <dt className="text-muted">{t.envelope.finalHash}</dt>
                <dd className="break-all font-mono text-xs">{env.finalSha256}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-2">
          {env.finalSha256 ? (
            <a href={`/envelopes/${env.id}/document?which=final&download`} className={buttonClass("primary")} data-testid="download-final">
              {t.envelope.downloadFinal}
            </a>
          ) : null}
          <a href={`/envelopes/${env.id}/document?download`} className={buttonClass("secondary")}>
            {t.envelope.downloadOriginal}
          </a>
          {env.status === "in_progress" ? (
            <ActionForm action={cancelAction.bind(null, env.id)} errors={t.errors} confirmMessage={t.envelope.cancelConfirm}>
              <SubmitButton variant="danger" className="w-full">
                {t.envelope.cancel}
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      </div>
    </div>
  );
}
