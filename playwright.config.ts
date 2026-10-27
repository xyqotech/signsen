import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const E2E_DATA_DIR = path.join(__dirname, "e2e", ".data");

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
    // A fresh database for every run; the production build, as deployed.
    command: `rm -rf "${E2E_DATA_DIR}" && npm run build && scripts/start-standalone.sh`,
    url: `${BASE_URL}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: {
      PORT: String(PORT),
      DATA_DIR: E2E_DATA_DIR,
      APP_URL: BASE_URL,
      MAIL_TRANSPORT: "file",
      APP_NAME: "SignSen E2E",
      DEFAULT_LOCALE: "fr",
      // Every test signs up from 127.0.0.1: lift the per-IP sign-in throttle for the suite only.
      SIGNIN_IP_LIMIT: "100000",
    },
  },
});
