import Link from "next/link";
import type { ReactNode } from "react";
import { setLocaleAction, signOutAction } from "@/app/actions";
import { getDictionary } from "@/i18n/dictionaries";
import { currentLocale, currentUser, services } from "@/server/request";
import { buttonClass } from "./ui";

/** Request-time shell: brand, navigation, language. Rendered inside <Suspense>. */
export async function AppShell({ children }: { children: ReactNode }) {
  const s = await services();
  const [user, locale] = await Promise.all([currentUser(), currentLocale()]);
  const t = getDictionary(locale);
  const brand = s.config.brand;
  return (
    <div lang={locale} className="flex min-h-screen flex-col">
      {/* BRAND_COLOR is validated as #rrggbb by the config schema: safe to inline. */}
      <style>{`:root{--brand:${brand.color}}`}</style>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href={user ? "/envelopes" : "/"} className="flex items-center gap-2 font-semibold">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- operator-provided logo of any origin
              <img src={brand.logoUrl} alt="" className="h-7 w-auto" />
            ) : (
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-brand-ink">
                {brand.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>{brand.name}</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {user ? (
              <Link href="/envelopes" className={buttonClass("ghost")}>
                {t.common.dashboard}
              </Link>
            ) : null}
            <Link href="/verify" className={buttonClass("ghost")}>
              {t.common.verifyDocument}
            </Link>
            <form action={setLocaleAction} className="flex items-center">
              <input type="hidden" name="locale" value={locale === "fr" ? "en" : "fr"} />
              <button type="submit" className={buttonClass("ghost")} aria-label={t.common.language}>
                {locale === "fr" ? "EN" : "FR"}
              </button>
            </form>
            {user ? (
              <form action={signOutAction}>
                <button type="submit" className={buttonClass("secondary")}>
                  {t.common.signOut}
                </button>
              </form>
            ) : (
              <Link href="/login" className={buttonClass("secondary")}>
                {t.common.signIn}
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl space-y-1 px-4 py-4 text-xs text-muted">
          <p>{t.home.legal}</p>
          <p>
            {brand.supportEmail ? <>{brand.supportEmail} · </> : null}
            {t.common.poweredBy}
          </p>
        </div>
      </footer>
    </div>
  );
}

export function ShellFallback() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="h-14 border-b border-line bg-surface" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="h-8 w-48 animate-pulse rounded bg-line" />
      </main>
    </div>
  );
}
