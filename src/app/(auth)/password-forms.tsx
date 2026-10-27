"use client";

import { ErrorText, FormPending, SubmitButton, useFormAction, type FormState } from "@/components/form-bits";
import { inputClass, Label, Notice } from "@/components/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import { forgotPasswordAction, resetPasswordAction } from "./actions";

export function ForgotPasswordForm({ t }: { t: Dictionary }) {
  const [state, submit, pending] = useFormAction<FormState>(forgotPasswordAction);
  if (state?.ok) return <Notice tone="success">{t.auth.forgotSent}</Notice>;
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormPending.Provider value={pending}>
        <p className="text-sm text-muted">{t.auth.forgotIntro}</p>
        <ErrorText state={state} errors={t.errors} />
        <div>
          <Label htmlFor="email">{t.common.email}</Label>
          <input id="email" name="email" type="email" required maxLength={254} autoComplete="email" className={inputClass} />
        </div>
        <SubmitButton className="w-full">{t.auth.forgotSubmit}</SubmitButton>
      </FormPending.Provider>
    </form>
  );
}

/** On success the action redirects to the sign-in page, which confirms the change. */
export function ResetPasswordForm({ token, t }: { token: string; t: Dictionary }) {
  const [state, submit, pending] = useFormAction<FormState>(resetPasswordAction);
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormPending.Provider value={pending}>
        <ErrorText state={state} errors={t.errors} />
        <input type="hidden" name="token" value={token} />
        <div>
          <Label htmlFor="password" hint={t.auth.passwordHint}>
            {t.auth.newPassword}
          </Label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={200}
            autoComplete="new-password"
            className={inputClass}
          />
        </div>
        <SubmitButton className="w-full">{t.auth.resetSubmit}</SubmitButton>
      </FormPending.Provider>
    </form>
  );
}
