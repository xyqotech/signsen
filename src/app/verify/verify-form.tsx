"use client";

import { ErrorText, SubmitButton, useFormAction, type FormState } from "@/components/form-bits";
import { Label, Notice } from "@/components/ui";
import { formatDate, type Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/server/config";
import { verifyAction, type VerifyResult } from "./actions";

export function VerifyForm({ t, locale }: { t: Dictionary; locale: Locale }) {
  const [state, submit, pending] = useFormAction<FormState & { result?: VerifyResult }>(verifyAction);
  const v = t.verify;
  const r = state?.ok ? state.result : undefined;
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor="file">{v.file}</Label>
          <input id="file" name="file" type="file" accept="application/pdf,.pdf" required className="block text-sm" />
        </div>
        <ErrorText state={state} errors={t.errors} />
        <SubmitButton pending={pending}>{v.submit}</SubmitButton>
      </form>
      {r ? (
        <div className="space-y-3" data-testid="verify-result">
          {r.envelope && r.sealedByThisInstance ? (
            <Notice tone="success">
              <strong>{v.valid}</strong> — {v.validHint}
            </Notice>
          ) : r.sealValid ? (
            <Notice tone="info">
              <strong>{v.sealOnly}</strong> — {v.sealOnlyHint}
            </Notice>
          ) : (
            <Notice tone="error">
              <strong>{v.invalid}</strong> — {v.invalidHint}
              {r.sealReason ? <span className="mt-1 block">{v.reasons[r.sealReason] ?? r.sealReason}</span> : null}
            </Notice>
          )}
          <dl className="grid gap-2 text-sm sm:grid-cols-[180px_1fr]">
            <dt className="text-muted">{v.sha256}</dt>
            <dd className="break-all font-mono text-xs">{r.sha256}</dd>
            {r.signerSubject ? (
              <>
                <dt className="text-muted">{v.sealedBy}</dt>
                <dd>{r.signerSubject}</dd>
              </>
            ) : null}
            {r.signingTime ? (
              <>
                <dt className="text-muted">{v.sealedAt}</dt>
                <dd>{formatDate(r.signingTime, locale)}</dd>
              </>
            ) : null}
            {r.envelope ? (
              <>
                <dt className="text-muted">{v.request}</dt>
                <dd>{r.envelope.title}</dd>
                <dt className="text-muted">{t.envelope.participants}</dt>
                <dd>
                  <ul>
                    {r.envelope.participants.map((p, i) => (
                      <li key={i}>
                        {p.name} ({p.email}) — {t.status.recipient[p.status as keyof typeof t.status.recipient] ?? p.status}
                        {p.actedAt ? `, ${formatDate(p.actedAt, locale)}` : ""}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
