"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

type Size = { width: number; height: number };

/**
 * Renders every page of a PDF to canvas (pdf.js handles /Rotate, so what is
 * shown is the displayed orientation) and lays an overlay on each page.
 * Overlay coordinates are the displayed page, origin top-left — the same
 * convention as the stored field ratios.
 */
export function PdfPages({
  url,
  renderOverlay,
  loadingLabel,
}: {
  url: string;
  renderOverlay?: (page: number, size: Size) => ReactNode;
  loadingLabel: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const loading = pdfjs.getDocument({ url });
        task = loading;
        const loaded = await loading.promise;
        if (!cancelled) setDoc(loaded);
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  if (error) return <p className="text-sm text-red-700">PDF ⚠</p>;
  if (!doc) return <div className="h-96 animate-pulse rounded-lg bg-line" aria-busy="true" aria-label={loadingLabel} />;
  return (
    <div className="space-y-4">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} pageNumber={i + 1} renderOverlay={renderOverlay} />
      ))}
    </div>
  );
}

function PdfPage({
  doc,
  pageNumber,
  renderOverlay,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  renderOverlay?: (page: number, size: Size) => ReactNode;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    // pdf.js refuses two renders on one canvas at once: renders are chained, and a
    // newer request (resize) cancels the one in flight before starting.
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let generation = 0;
    let disposed = false;
    let lastWidth = -1;

    const draw = async (mine: number) => {
      const el = wrapper.current;
      const cv = canvas.current;
      if (!el || !cv || disposed || mine !== generation) return;
      const page = await doc.getPage(pageNumber);
      if (disposed || mine !== generation) return;
      const natural = page.getViewport({ scale: 1 });
      const cssWidth = el.clientWidth;
      const scale = cssWidth / natural.width;
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      cv.width = Math.floor(viewport.width);
      cv.height = Math.floor(viewport.height);
      cv.style.width = `${cssWidth}px`;
      cv.style.height = `${natural.height * scale}px`;
      setSize({ width: cssWidth, height: natural.height * scale });
      const rendering = page.render({ canvas: cv, viewport });
      task = rendering;
      await rendering.promise.catch(() => undefined);
    };

    const observer = new ResizeObserver(() => {
      const width = wrapper.current?.clientWidth ?? 0;
      if (width === lastWidth) return; // the overlay's own changes must not re-render
      lastWidth = width;
      const mine = ++generation;
      task?.cancel();
      queue = queue.then(() => draw(mine)).catch(() => undefined);
    });
    if (wrapper.current) observer.observe(wrapper.current);
    return () => {
      disposed = true;
      task?.cancel();
      observer.disconnect();
    };
  }, [doc, pageNumber]);

  return (
    <div
      ref={wrapper}
      data-page={pageNumber}
      data-ready={size ? "true" : undefined}
      className="relative w-full overflow-hidden rounded-lg border border-line bg-white shadow-sm"
    >
      <canvas ref={canvas} className="block" aria-label={`Page ${pageNumber}`} />
      {size && renderOverlay ? <div className="absolute inset-0">{renderOverlay(pageNumber, size)}</div> : null}
    </div>
  );
}
