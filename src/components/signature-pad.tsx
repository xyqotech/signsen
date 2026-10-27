"use client";

import { useEffect, useRef, useState } from "react";

export type SignatureValue = { kind: "drawn" | "typed"; dataUrl: string } | null;

const INK = "#1a2a6c";
const HEIGHT = 170;

/** Crops a canvas to its inked pixels (plus a margin) and returns a PNG data URL. */
function trimmed(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  const w = Math.min(width, maxX - minX + 1 + pad * 2);
  const h = Math.min(height, maxY - minY + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, Math.max(0, minX - pad), Math.max(0, minY - pad), w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

export function SignaturePad({
  onChange,
  labels,
  defaultName,
}: {
  onChange: (value: SignatureValue) => void;
  labels: { draw: string; type: string; clear: string; typeName: string };
  defaultName: string;
}) {
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [name, setName] = useState(defaultName);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const strokes = useRef(0);

  const setup = () => {
    const cv = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    const width = cv.parentElement!.clientWidth;
    cv.width = Math.floor(width * ratio);
    cv.height = Math.floor(HEIGHT * ratio);
    cv.style.width = `${width}px`;
    cv.style.height = `${HEIGHT}px`;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2.4;
    return ctx;
  };

  const renderTyped = (text: string) => {
    const ctx = setup();
    const cv = canvas.current!;
    const width = cv.clientWidth;
    let size = 54;
    ctx.font = `${size}px "Segoe Script", "Brush Script MT", "Apple Chancery", cursive`;
    while (size > 18 && ctx.measureText(text).width > width - 24) {
      size -= 2;
      ctx.font = `${size}px "Segoe Script", "Brush Script MT", "Apple Chancery", cursive`;
    }
    ctx.textBaseline = "middle";
    ctx.fillText(text, 12, HEIGHT / 2);
    onChange(text.trim() ? { kind: "typed", dataUrl: trimmed(cv)! } : null);
  };

  useEffect(() => {
    if (mode === "typed") renderTyped(name);
    else {
      setup();
      strokes.current = 0;
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on mode switch only
  }, [mode]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1" role="tablist">
        {(["drawn", "typed"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-brand text-brand-ink" : "bg-background text-muted"}`}
          >
            {m === "drawn" ? labels.draw : labels.type}
          </button>
        ))}
      </div>
      {mode === "typed" ? (
        <input
          aria-label={labels.typeName}
          placeholder={labels.typeName}
          value={name}
          maxLength={60}
          onChange={(e) => {
            setName(e.target.value);
            renderTyped(e.target.value);
          }}
          className="w-full rounded-lg border border-line px-3 py-2 text-sm"
        />
      ) : null}
      <div className="relative rounded-lg border border-dashed border-line bg-white">
        <canvas
          ref={canvas}
          data-testid="signature-canvas"
          aria-label={mode === "drawn" ? labels.draw : labels.typeName}
          className={`block touch-none ${mode === "drawn" ? "cursor-crosshair" : ""}`}
          onPointerDown={(e) => {
            if (mode !== "drawn") return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = point(e);
            const ctx = e.currentTarget.getContext("2d")!;
            ctx.beginPath();
            ctx.arc(drawing.current.x, drawing.current.y, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }}
          onPointerMove={(e) => {
            if (mode !== "drawn" || !drawing.current) return;
            const p = point(e);
            const ctx = e.currentTarget.getContext("2d")!;
            ctx.beginPath();
            ctx.moveTo(drawing.current.x, drawing.current.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            drawing.current = p;
          }}
          onPointerUp={(e) => {
            if (mode !== "drawn" || !drawing.current) return;
            drawing.current = null;
            strokes.current += 1;
            const url = trimmed(e.currentTarget);
            onChange(url ? { kind: "drawn", dataUrl: url } : null);
          }}
        />
        <span aria-hidden className="pointer-events-none absolute bottom-8 left-6 right-6 border-b border-zinc-300" />
        <button
          type="button"
          onClick={() => {
            if (mode === "typed") {
              setName("");
              renderTyped("");
            } else {
              setup();
              strokes.current = 0;
              onChange(null);
            }
          }}
          className="absolute right-2 top-2 rounded px-2 py-0.5 text-xs text-muted hover:text-foreground"
        >
          {labels.clear}
        </button>
      </div>
    </div>
  );
}
