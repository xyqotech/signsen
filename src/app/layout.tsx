import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell, ShellFallback } from "@/components/chrome";
import { services } from "@/server/request";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const s = await services();
  return {
    title: { default: s.config.brand.name, template: `%s · ${s.config.brand.name}` },
    description: "Electronic signature — SignSen",
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full">
        <Suspense fallback={<ShellFallback />}>
          <AppShell>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
