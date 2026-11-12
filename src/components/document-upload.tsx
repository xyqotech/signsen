"use client";

import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { ErrorText, useFormAction, type FormState } from "./form-bits";
import { Label } from "./ui";

/**
 * The PDF of a draft. Choosing a file uploads it: a chosen file whose name is
 * on screen looks added, so there is no second button to forget. Replacing a
 * document removes its signature boxes and asks first. `current` is the name of
 * the document already attached, if any.
 */
export function DocumentUpload({
  action,
  current,
  t,
}: {
  action: (prev: FormState | null, formData: FormData) => Promise<FormState>;
  current: string | null;
  t: Dictionary;
}) {
  const [state, submit, pending] = useFormAction<FormState>(action);
  const input = useRef<HTMLInputElement>(null);
  // The upload in progress, or the last one.
  const [last, setLast] = useState<{ name: string; replaced: boolean } | null>(null);

  // A file chosen before this component was ready (slow connection) told nobody: handle it now.
  useEffect(() => {
    if (input.current?.files?.length) input.current.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        setLast({ name: input.current?.files?.[0]?.name ?? "", replaced: current !== null });
        submit(e);
        // The data sent keeps the file; the name next to the button would look like a document already there.
        e.currentTarget.reset();
      }}
    >
      <ErrorText state={pending ? null : state} errors={t.errors} />
      <div>
        <Label htmlFor="document" hint={current ? t.editor.replaceWarning : t.editor.uploadHint}>
          {current ? t.editor.replace : t.editor.upload}
        </Label>
        {/* Not disabled while uploading: it would lose the keyboard focus. */}
        <input
          ref={input}
          id="document"
          name="document"
          type="file"
          accept="application/pdf,.pdf"
          required
          className="block text-sm"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            const form = e.currentTarget.form;
            if (!file || !form) return;
            if (current && !window.confirm(`${current} → ${file.name}\n\n${t.editor.replaceConfirm}`)) {
              form.reset();
              return;
            }
            form.requestSubmit();
          }}
        />
      </div>
      <p role="status" className="min-h-5 text-sm text-muted">
        {pending
          ? `${last?.name ? `${last.name} — ` : ""}${t.editor.uploading}`
          : state?.ok
            ? last?.replaced
              ? t.editor.documentReplaced
              : t.editor.documentAdded
            : ""}
      </p>
    </form>
  );
}
