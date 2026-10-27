import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function buttonClass(variant: Variant = "primary", extra = "") {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles: Record<Variant, string> = {
    primary: "bg-brand text-brand-ink hover:brightness-110",
    secondary: "border border-line bg-surface text-foreground hover:bg-background",
    danger: "border border-red-200 bg-surface text-red-700 hover:bg-red-50",
    ghost: "text-muted hover:text-foreground",
  };
  return `${base} ${styles[variant]} ${extra}`;
}

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/70 focus:border-brand focus:outline-none";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}>{children}</section>;
}

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {aside}
    </div>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
      {children}
      {hint ? <span className="mt-0.5 block text-xs font-normal text-muted">{hint}</span> : null}
    </label>
  );
}

const tones = {
  draft: "bg-zinc-100 text-zinc-700",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  declined: "bg-red-100 text-red-800",
  cancelled: "bg-zinc-200 text-zinc-700",
  waiting: "bg-zinc-100 text-zinc-600",
  notified: "bg-sky-100 text-sky-800",
  viewed: "bg-indigo-100 text-indigo-800",
  signed: "bg-emerald-100 text-emerald-800",
  approved: "bg-emerald-100 text-emerald-800",
} as const;

export function Badge({ status, children }: { status: string; children: ReactNode }) {
  const tone = tones[status as keyof typeof tones] ?? "bg-zinc-100 text-zinc-700";
  return (
    <span data-status={status} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {children}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "error"; children: ReactNode }) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    error: "border-red-200 bg-red-50 text-red-900",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${styles[tone]}`}>
      {children}
    </div>
  );
}
