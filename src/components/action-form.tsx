"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { ErrorText, FormPending, useFormAction, type FormState } from "./form-bits";

export function ActionForm({
  action,
  errors,
  children,
  className = "space-y-3",
  resetOnSuccess = false,
  confirmMessage,
  successMessage,
}: {
  action: (prev: FormState | null, formData: FormData) => Promise<FormState>;
  errors: Dictionary["errors"];
  children: ReactNode;
  className?: string;
  /** Clears the fields after a successful submission (what the user typed is kept on error). */
  resetOnSuccess?: boolean;
  /** Asks the browser to confirm before submitting (irreversible actions). */
  confirmMessage?: string;
  successMessage?: string;
}) {
  const [state, submit, pending] = useFormAction<FormState>(action);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) form.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={form}
      className={className}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          e.preventDefault();
          return;
        }
        submit(e);
      }}
    >
      <FormPending.Provider value={pending}>
        <ErrorText state={state} errors={errors} />
        {state?.ok && successMessage ? (
          <p role="status" className="text-sm text-emerald-700">
            {successMessage}
          </p>
        ) : null}
        {children}
      </FormPending.Provider>
    </form>
  );
}
