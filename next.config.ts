import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosting: `next build` emits .next/standalone, copied into the Docker image.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // Node-only crypto/PDF/mail libraries stay out of the bundle (better-sqlite3 is
  // already in Next's default list).
  serverExternalPackages: [
    "@signpdf/signpdf",
    "@signpdf/signer-p12",
    "@signpdf/placeholder-pdf-lib",
    "@signpdf/utils",
    "node-forge",
    "nodemailer",
    "pdf-lib",
  ],
  experimental: {
    // PDFs up to 20 MB are uploaded through a Server Action.
    serverActions: { bodySizeLimit: "21mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Signing links carry a personal token in the URL: never leak it in Referer.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/s/:token*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
