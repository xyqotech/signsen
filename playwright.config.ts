import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const E2E_DATA_DIR = path.join(__dirname, "e2e", ".data");

// The same PostgreSQL server as the unit tests (a role allowed to create
// databases); the suite gets its own database there, recreated for every run.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The end-to-end tests need a PostgreSQL server, " +
      "e.g. TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres (see CONTRIBUTING.md).",
  );
}
const e2eDatabaseUrl = new URL(TEST_DATABASE_URL);
e2eDatabaseUrl.pathname = `/signsen_e2e_${PORT}`;

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "fr-FR",
    // Lets a machine reuse an already installed Chromium instead of downloading one.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /ceremony|smoke/ },
  ],
  webServer: {
    // An empty database and data directory for every run; the production build, as deployed.
    command: `rm -rf "${E2E_DATA_DIR}" && node e2e/support/reset-database.mjs && npm run build && scripts/start-standalone.sh`,
    url: `${BASE_URL}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: {
      PORT: String(PORT),
      DATA_DIR: E2E_DATA_DIR,
      DATABASE_URL: e2eDatabaseUrl.toString(),
      TEST_DATABASE_URL,
      APP_URL: BASE_URL,
      MAIL_TRANSPORT: "file",
      APP_NAME: "SignSen E2E",
      DEFAULT_LOCALE: "fr",
      // Every test signs up from 127.0.0.1: lift the per-IP sign-in throttle for the suite only.
      SIGNIN_IP_LIMIT: "100000",
    },
  },
});
