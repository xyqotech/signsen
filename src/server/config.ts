import path from "node:path";
import { z } from "zod";

const locales = ["fr", "en"] as const;
export type Locale = (typeof locales)[number];
export const SUPPORTED_LOCALES: readonly Locale[] = locales;

const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  DATA_DIR: z.string().min(1).default("./data"),
  APP_NAME: z.string().min(1).max(60).default("SignSen"),
  BRAND_COLOR: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "BRAND_COLOR must look like #1f6f5c")
    .default("#1f6f5c"),
  BRAND_LOGO_URL: z.string().optional(),
  DEFAULT_LOCALE: z.enum(locales).default("fr"),
  SUPPORT_EMAIL: z.email().optional(),
  ALLOW_SIGNUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  MAIL_TRANSPORT: z.enum(["smtp", "file", "console"]).default("console"),
  MAIL_FROM: z.string().default("SignSen <no-reply@localhost>"),
  SMTP_URL: z.string().optional(),
  /** Sign-in attempts allowed per IP address and 15 minutes (an office behind one NAT shares it). */
  SIGNIN_IP_LIMIT: z.coerce.number().int().min(1).default(50),
  SEAL_P12_PATH: z.string().optional(),
  SEAL_P12_PASSWORD: z.string().optional(),
});

export interface AppConfig {
  appUrl: string;
  dataDir: string;
  brand: {
    name: string;
    color: string;
    logoUrl?: string;
    supportEmail?: string;
  };
  defaultLocale: Locale;
  allowSignup: boolean;
  mail: {
    transport: "smtp" | "file" | "console";
    from: string;
    smtpUrl?: string;
  };
  signinIpLimit: number;
  seal: { p12Path?: string; p12Password?: string };
}

/** Parses an environment-like object. Throws with every problem listed. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration — ${problems}`);
  }
  const e = result.data;
  if (e.MAIL_TRANSPORT === "smtp" && !e.SMTP_URL) {
    throw new Error("Invalid configuration — SMTP_URL is required when MAIL_TRANSPORT=smtp");
  }
  if ((e.SEAL_P12_PATH === undefined) !== (e.SEAL_P12_PASSWORD === undefined)) {
    throw new Error(
      "Invalid configuration — SEAL_P12_PATH and SEAL_P12_PASSWORD go together",
    );
  }
  return {
    appUrl: e.APP_URL.replace(/\/+$/, ""),
    dataDir: path.resolve(e.DATA_DIR),
    brand: {
      name: e.APP_NAME,
      color: e.BRAND_COLOR.toLowerCase(),
      logoUrl: e.BRAND_LOGO_URL,
      supportEmail: e.SUPPORT_EMAIL,
    },
    defaultLocale: e.DEFAULT_LOCALE,
    allowSignup: e.ALLOW_SIGNUP,
    mail: { transport: e.MAIL_TRANSPORT, from: e.MAIL_FROM, smtpUrl: e.SMTP_URL },
    signinIpLimit: e.SIGNIN_IP_LIMIT,
    seal: { p12Path: e.SEAL_P12_PATH, p12Password: e.SEAL_P12_PASSWORD },
  };
}
