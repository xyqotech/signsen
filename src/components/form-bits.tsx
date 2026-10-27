"use client";

import { createContext, startTransition, useActionState, useContext, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { Dictionary } from "@/i18n/dictionaries";
import { buttonClass } from "./ui";

/** Pending flag of the enclosing useFormAction form, for the buttons inside it. */
export const FormPending = createContext<boolean | undefined>(undefined);

export function SubmitButton({
  children,
  variant = "primary",
  className = "",
  name,
  value,
  disabled,
  pending: pendingProp,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  className?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  /** For forms submitted through useFormAction (useFormStatus does not see them). */
  pending?: boolean;
}) {
  const status = useFormStatus();
  const fromForm = useContext(FormPending);
  const pending = pendingProp ?? fromForm ?? status.pending;
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} aria-busy={pending} className={buttonClass(variant, className)}>
      {children}
    </button>
  );
}

/**
 * Like useActionState, but keeps what the user typed when the action fails.
 * React resets a `<form action>` after every submission, errors included: a
 * wrong one-time code would silently untick the consent box, a wrong password
 * would wipe the e-mail. Submitting through a transition avoids that reset;
 * forms that should be cleared after a success do it explicitly.
 */
export function useFormAction<S>(action: (state: S | null, formData: FormData) => Promise<S>) {
  const [state, dispatch, pending] = useActionState<S | null, FormData>(action, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(e.currentTarget, submitter instanceof HTMLElement ? submitter : null);
    startTransition(() => dispatch(data));
  };
  return [state, onSubmit, pending] as const;
}

export type FormState = {
  ok: boolean;
  error?: string;
  fields?: Record<string, string>;
  details?: Record<string, unknown>;
  message?: string;
};

/** Shows the translated error of a form state, with readiness problems when present. */
export function ErrorText({ state, errors }: { state: FormState | null; errors: Dictionary["errors"] }) {
  if (!state || state.ok || !state.error) return null;
  const problems = (state.details?.problems as string[] | undefined) ?? [];
  const message = (errors as Record<string, unknown>)[state.error];
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
      <p>{typeof message === "string" ? message : errors.generic}</p>
      {problems.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{errors.problems[p] ?? p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
