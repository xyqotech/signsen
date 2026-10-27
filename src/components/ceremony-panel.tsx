"use client";

import { useEffect, useRef, useState } from "react";
import { actAction, declineAction, requestCodeAction } from "@/app/s/[token]/actions";
import type { Dictionary } from "@/i18n/dictionaries";
import type { CeremonyView } from "@/server/ceremony";
import { ErrorText, SubmitButton, useFormAction, type FormState } from "./form-bits";
import { PdfPages } from "./pdf-pages";
import { SignaturePad, type SignatureValue } from "./signature-pad";
import { inputClass, Label } from "./ui";

export function CeremonyPanel({ token, view, t }: { token: string; view: CeremonyView; t: Dictionary }) {
  const c = t.ceremony;
  const isSigner = view.recipient.role === "signer";
  // Submitted through transitions: a wrong code must not untick consent or clear the fields.
  const [codeState, requestCodeSubmit, codePending] = useFormAction<FormState>(requestCodeAction.bind(null, token));
  const [actState, actSubmit, actPending] = useFormAction<FormState>(actAction.bind(null, token));
  const [declineState, declineSubmit, declinePending] = useFormAction<FormState>(declineAction.bind(null, token));
  const [signature, setSignature] = useState<SignatureValue>(null);
  const [declining, setDeclining] = useState(false);
  const codeSent = codeState?.ok === true;
  // On phones the panel comes after the whole document: offer a shortcut while it is off screen.
  const panel = useRef<HTMLDivElement>(null);
  const [panelVisible, setPanelVisible] = useState(true);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setPanelVisible(entry.isIntersecting), { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div>
        <p className="mb-3 text-sm text-muted">{c.yourFields}</p>
        <PdfPages
          url={`/s/${token}/document`}
          loadingLabel={t.common.loading}
          renderOverlay={(page, size) =>
            view.fields
              .filter((f) => f.page === page)
              .map((f) => (
                <div
                  key={f.id}
                  data-testid="my-field"
                  className="absolute grid place-items-center rounded border-2 border-dashed border-brand bg-brand/10 text-xs font-semibold text-brand"
                  style={{ left: f.x * size.width, top: f.y * size.height, width: f.width * size.width, height: f.height * size.height }}
                >
                  {isSigner ? c.sign : c.approve}
                </div>
              ))
          }
        />
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div ref={panel} id="signer-panel" className="scroll-mt-4 space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm">
          <p className="font-medium">{isSigner ? c.toSign : c.toApprove}</p>

          <form onSubmit={requestCodeSubmit} className="space-y-2">
            <p className="text-sm font-semibold">{c.step1}</p>
            <p className="text-sm text-muted">
              {c.step1Hint} <strong className="text-foreground">{view.recipient.email}</strong>
            </p>
            <ErrorText state={codeState} errors={t.errors} />
            {codeSent ? (
              <p role="status" className="text-sm text-emerald-700">
                {c.codeSent}
              </p>
            ) : null}
            <SubmitButton variant={codeSent ? "secondary" : "primary"} className="w-full" pending={codePending}>
              {codeSent ? c.resendCode : c.getCode}
            </SubmitButton>
          </form>

          {!declining ? (
            <form onSubmit={actSubmit} className="space-y-3 border-t border-line pt-4">
              <div>
                <Label htmlFor="code">{c.step2}</Label>
                <input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  placeholder="123456"
                  aria-label={c.code}
                  className={`${inputClass} text-center font-mono text-lg tracking-[0.4em]`}
                />
              </div>
              <div>
                <p className="mb-1 text-sm font-semibold">{isSigner ? c.step3Sign : c.step3Approve}</p>
                {isSigner ? (
                  <>
                    <SignaturePad
                      onChange={setSignature}
                      defaultName={view.recipient.name}
                      labels={{ draw: c.draw, type: c.type, clear: c.clear, typeName: c.typeName }}
                    />
                    <input type="hidden" name="signature" value={signature?.dataUrl ?? ""} />
                    <input type="hidden" name="signatureKind" value={signature?.kind ?? "drawn"} />
                  </>
                ) : null}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="consent" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                <span>{isSigner ? c.consentSign : c.consentApprove}</span>
              </label>
              <ErrorText state={actState} errors={t.errors} />
              <SubmitButton className="w-full" disabled={isSigner && !signature} pending={actPending}>
                {isSigner ? c.sign : c.approve}
              </SubmitButton>
            </form>
          ) : (
            <form onSubmit={declineSubmit} className="space-y-3 border-t border-line pt-4">
              <p className="text-sm font-semibold">{c.declineTitle}</p>
              <p className="text-xs text-muted">{c.declineHint}</p>
              <div>
                <Label htmlFor="decline-code">{c.code}</Label>
                <input id="decline-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className={`${inputClass} font-mono`} />
              </div>
              <div>
                <Label htmlFor="reason">{c.declineReason}</Label>
                <textarea id="reason" name="reason" required maxLength={500} rows={3} className={inputClass} />
              </div>
              <ErrorText state={declineState} errors={t.errors} />
              <div className="flex gap-2">
                <SubmitButton variant="danger" pending={declinePending}>{c.declineConfirm}</SubmitButton>
                <button type="button" onClick={() => setDeclining(false)} className="text-sm text-muted hover:text-foreground">
                  {t.common.cancel}
                </button>
              </div>
            </form>
          )}
          {!declining ? (
            <button type="button" onClick={() => setDeclining(true)} className="text-sm text-muted underline-offset-2 hover:text-red-700 hover:underline">
              {c.decline}
            </button>
          ) : null}
        </div>
        <p className="text-xs text-muted">{c.legal}</p>
      </aside>
      {!panelVisible ? (
        <a
          href="#signer-panel"
          className="fixed inset-x-4 bottom-4 z-20 rounded-xl bg-brand px-4 py-3 text-center text-sm font-semibold text-brand-ink shadow-lg lg:hidden"
        >
          {isSigner ? c.goToSign : c.goToApprove}
        </a>
      ) : null}
    </div>
  );
}
