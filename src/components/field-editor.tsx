"use client";

import { useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from "react";
import { saveFieldsAction } from "@/app/envelopes/actions";
import type { Dictionary } from "@/i18n/dictionaries";
import { ErrorText, type FormState } from "./form-bits";
import { PdfPages } from "./pdf-pages";
import { buttonClass } from "./ui";

type Field = { key: string; recipientId: string; page: number; x: number; y: number; width: number; height: number };
type Signer = { id: string; name: string };

const COLORS = ["#2563eb", "#d97706", "#7c3aed", "#059669", "#db2777", "#0891b2"];
const DEFAULT = { width: 0.26, height: 0.075 };
const MIN = { width: 0.05, height: 0.025 };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
let counter = 0;
const newKey = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export function FieldEditor({
  envelopeId,
  documentUrl,
  signers,
  initial,
  t,
}: {
  envelopeId: string;
  documentUrl: string;
  signers: Signer[];
  initial: Omit<Field, "key">[];
  t: Dictionary;
}) {
  const [fields, setFields] = useState<Field[]>(() => initial.map((f) => ({ ...f, key: newKey() })));
  const [active, setActive] = useState(signers[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<FormState | null>(null);
  const [pending, startTransition] = useTransition();
  const drag = useRef<{ key: string; mode: "move" | "resize"; startX: number; startY: number; origin: Field; size: { width: number; height: number } } | null>(null);

  const colorOf = (recipientId: string) => COLORS[Math.max(0, signers.findIndex((s) => s.id === recipientId)) % COLORS.length];
  const nameOf = (recipientId: string) => signers.find((s) => s.id === recipientId)?.name ?? "?";

  const update = (next: Field[]) => {
    setFields(next);
    setDirty(true);
    setState(null);
  };

  const addAt = (page: number, size: { width: number; height: number }, e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / size.width;
    const cy = (e.clientY - rect.top) / size.height;
    update([
      ...fields,
      {
        key: newKey(),
        recipientId: active,
        page,
        width: DEFAULT.width,
        height: DEFAULT.height,
        x: clamp(cx - DEFAULT.width / 2, 0, 1 - DEFAULT.width),
        y: clamp(cy - DEFAULT.height / 2, 0, 1 - DEFAULT.height),
      },
    ]);
  };

  const startDrag = (f: Field, mode: "move" | "resize", size: { width: number; height: number }, e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { key: f.key, mode, startX: e.clientX, startY: e.clientY, origin: f, size };
  };

  const onDrag = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.size.width;
    const dy = (e.clientY - d.startY) / d.size.height;
    const o = d.origin;
    const moved =
      d.mode === "move"
        ? { ...o, x: clamp(o.x + dx, 0, 1 - o.width), y: clamp(o.y + dy, 0, 1 - o.height) }
        : { ...o, width: clamp(o.width + dx, MIN.width, 1 - o.x), height: clamp(o.height + dy, MIN.height, 1 - o.y) };
    setFields((list) => list.map((f) => (f.key === d.key ? moved : f)));
    setDirty(true);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const nudge = (f: Field, key: string) => {
    const step = 0.01;
    const deltas: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (key === "Delete" || key === "Backspace") return update(fields.filter((x) => x.key !== f.key));
    const d = deltas[key];
    if (!d) return;
    update(fields.map((x) => (x.key === f.key ? { ...x, x: clamp(x.x + d[0], 0, 1 - x.width), y: clamp(x.y + d[1], 0, 1 - x.height) } : x)));
  };

  const save = () =>
    startTransition(async () => {
      const result = await saveFieldsAction(
        envelopeId,
        fields.map(({ recipientId, page, x, y, width, height }) => ({ recipientId, page, x, y, width, height })),
      );
      setState(result);
      if (result.ok) setDirty(false);
    });

  if (signers.length === 0) return <p className="text-sm text-muted">{t.editor.noSigner}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t.editor.fieldsHint}</p>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface/95 p-2 backdrop-blur">
        <span className="text-sm text-muted">{t.editor.fieldFor}</span>
        {signers.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={active === s.id}
            onClick={() => setActive(s.id)}
            className={`rounded-full border px-3 py-1 text-sm ${active === s.id ? "text-white" : "bg-surface"}`}
            style={active === s.id ? { background: colorOf(s.id), borderColor: colorOf(s.id) } : { borderColor: colorOf(s.id), color: colorOf(s.id) }}
          >
            {s.name} · {fields.filter((f) => f.recipientId === s.id).length}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {state?.ok && !dirty ? <span className="text-sm text-emerald-700">{t.editor.fieldsSaved}</span> : null}
          <button type="button" onClick={save} disabled={pending || !dirty} className={buttonClass("primary")} data-testid="save-fields">
            {t.editor.saveFields}
          </button>
        </div>
      </div>
      <ErrorText state={state} errors={t.errors} />
      <PdfPages
        url={documentUrl}
        loadingLabel={t.common.loading}
        renderOverlay={(page, size) => (
          <div
            className="absolute inset-0 cursor-crosshair"
            data-testid={`page-overlay-${page}`}
            onPointerDown={(e) => addAt(page, size, e)}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
          >
            {fields
              .filter((f) => f.page === page)
              .map((f) => (
                <div
                  key={f.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.editor.fieldFor} ${nameOf(f.recipientId)}`}
                  data-testid="field"
                  onKeyDown={(e) => {
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace"].includes(e.key)) {
                      e.preventDefault();
                      nudge(f, e.key);
                    }
                  }}
                  onPointerDown={(e) => startDrag(f, "move", size, e)}
                  className="absolute flex cursor-move select-none items-start justify-between rounded border-2 text-[11px] font-medium"
                  style={{
                    left: f.x * size.width,
                    top: f.y * size.height,
                    width: f.width * size.width,
                    height: f.height * size.height,
                    borderColor: colorOf(f.recipientId),
                    background: `${colorOf(f.recipientId)}22`,
                    color: colorOf(f.recipientId),
                  }}
                >
                  <span className="truncate px-1">{nameOf(f.recipientId)}</span>
                  <button
                    type="button"
                    aria-label={t.editor.removeField}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => update(fields.filter((x) => x.key !== f.key))}
                    className="px-1 leading-none"
                  >
                    ×
                  </button>
                  <span
                    aria-hidden
                    onPointerDown={(e) => startDrag(f, "resize", size, e)}
                    className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm"
                    style={{ background: colorOf(f.recipientId) }}
                  />
                </div>
              ))}
          </div>
        )}
      />
    </div>
  );
}
