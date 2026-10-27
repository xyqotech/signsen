"use client";

import { ErrorText, FormPending, SubmitButton, useFormAction, type FormState } from "@/components/form-bits";
import { inputClass, Label } from "@/components/ui";
import type { Dictionary } from "@/i18n/dictionaries";
import { loginAction, signupAction } from "./actions";

export function AuthForm({ mode, t }: { mode: "login" | "signup"; t: Dictionary }) {
  const [state, submit, pending] = useFormAction<FormState>(mode === "login" ? loginAction : signupAction);
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormPending.Provider value={pending}>
      <ErrorText state={state} errors={t.errors} />
      {mode === "signup" ? (
        <div>
          <Label htmlFor="name">{t.common.name}</Label>
          <input id="name" name="name" required maxLength={100} autoComplete="name" className={inputClass} />
        </div>
      ) : null}
      <div>
        <Label htmlFor="email">{t.common.email}</Label>
        <input id="email" name="email" type="email" required maxLength={254} autoComplete="email" className={inputClass} />
      </div>
      <div>
        <Label htmlFor="password" hint={mode === "signup" ? t.auth.passwordHint : undefined}>
          {t.common.password}
        </Label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 10 : undefined}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className={inputClass}
        />
      </div>
      <SubmitButton className="w-full">{mode === "login" ? t.common.signIn : t.common.signUp}</SubmitButton>
      </FormPending.Provider>
    </form>
  );
}
