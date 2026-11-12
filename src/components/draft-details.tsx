"use client";

import { createContext, startTransition, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { ErrorText, FormPending, SubmitButton, useFormAction, type FormState } from "./form-bits";
import { inputClass, Label } from "./ui";

type Action = (prev: FormState | null, formData: FormData) => Promise<FormState>;

/** The details form of the draft, so that sending reads what is typed in it. */
const DetailsFormContext = createContext<RefObject<HTMLFormElement | null> | null>(null);

/** Wraps the sections of the draft editor that share the title and the message. */
export function DraftScope({ children }: { children: ReactNode }) {
  const details = useRef<HTMLFormElement>(null);
  return <DetailsFormContext.Provider value={details}>{children}</DetailsFormContext.Provider>;
}

/** Title and message as typed, trimmed the way the server stores them. */
function typed(form: HTMLFormElement) {
  const data = new FormData(form);
  return { title: String(data.get("title") ?? "").trim(), message: String(data.get("message") ?? "").trim() };
}

/**
 * Title and message of a draft. They are saved when a field loses focus, on
 * Enter and with the button, so that nothing typed is lost because a button was
 * not clicked. `title` and `message` are the saved values.
 */
export function DetailsForm({ action, title, message, t }: { action: Action; title: string; message: string; t: Dictionary }) {
  const form = useContext(DetailsFormContext);
  const [state, submit, pending] = useFormAction<FormState>(action);
  const [edited, setEdited] = useState(false);
  // What the save in flight carries: leaving the next field must not send it again.
  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) inFlight.current = null;
  }, [pending]);

  return (
    <form
      ref={form}
      className="space-y-3"
      onInput={() => setEdited(true)}
      onBlur={(e) => {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) return;
        const now = typed(e.currentTarget);
        // An empty title is left for the user to fix: no message while they are still typing elsewhere.
        if (!now.title || (now.title === title && now.message === message) || JSON.stringify(now) === inFlight.current) return;
        e.currentTarget.requestSubmit();
      }}
      onSubmit={(e) => {
        inFlight.current = JSON.stringify(typed(e.currentTarget));
        setEdited(false);
        submit(e);
      }}
    >
      <ErrorText state={pending ? null : state} errors={t.errors} />
      <div>
        <Label htmlFor="title">{t.editor.title}</Label>
        <input id="title" name="title" defaultValue={title} required maxLength={200} className={inputClass} />
      </div>
      <div>
        <Label htmlFor="message">{t.editor.message}</Label>
        <textarea id="message" name="message" defaultValue={message} maxLength={2000} rows={3} className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {/* Never disabled: a save started by leaving a field must not take the focus away from this button. */}
        <SubmitButton variant="secondary" pending={false}>
          {t.common.save}
        </SubmitButton>
        <p role="status" className="text-sm text-emerald-700">
          {pending ? t.editor.saving : state?.ok && !edited ? t.editor.saved : ""}
        </p>
      </div>
    </form>
  );
}

/**
 * Sends the envelope together with the title and the message as they are typed
 * at that moment: the server saves them first. A sent envelope is frozen, so
 * this is the last chance for a title that was not saved on its own.
 */
export function SendForm({ action, errors, children }: { action: Action; errors: Dictionary["errors"]; children: ReactNode }) {
  const details = useContext(DetailsFormContext);
  const [state, , pending, dispatch] = useFormAction<FormState>(action);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = details?.current;
        // An empty title: the browser says so on the field itself and moves the focus there.
        if (form && !form.reportValidity()) return;
        const data = new FormData(e.currentTarget);
        if (form) {
          const now = new FormData(form);
          data.set("title", String(now.get("title") ?? ""));
          data.set("message", String(now.get("message") ?? ""));
        }
        startTransition(() => dispatch(data));
      }}
    >
      <FormPending.Provider value={pending}>
        <ErrorText state={state} errors={errors} />
        {children}
      </FormPending.Provider>
    </form>
  );
}
