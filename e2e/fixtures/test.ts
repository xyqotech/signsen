import path from "node:path";
import { test as base, type BrowserContext } from "@playwright/test";
import { AuthPage } from "../pages/auth.page";
import { CeremonyPage } from "../pages/ceremony.page";
import { DashboardPage } from "../pages/dashboard.page";
import { EnvelopePage } from "../pages/envelope.page";
import { VerifyPage } from "../pages/verify.page";
import { Mailbox } from "../support/mailbox";
import { PASSWORD, person } from "../support/test-data";

export const OUTBOX = path.join(__dirname, "..", ".data", "outbox");

type Owner = { name: string; email: string; password: string };

interface Fixtures {
  mailbox: Mailbox;
  auth: AuthPage;
  dashboard: DashboardPage;
  envelope: EnvelopePage;
  verify: VerifyPage;
  /** A fresh, not yet registered sender. */
  owner: Owner;
  /** The same sender, registered and signed in on `page`. */
  signedInOwner: Owner;
  /** Opens the ceremony for a recipient in a separate browser context (their own device). */
  recipientPage: () => Promise<CeremonyPage>;
}

// Fixture callbacks name their second argument `provide` (Playwright calls it `use`)
// so the React hooks lint rule does not mistake it for React's use().
export const test = base.extend<Fixtures>({
  mailbox: async ({}, provide) => provide(new Mailbox(OUTBOX)),
  auth: async ({ page }, provide) => provide(new AuthPage(page)),
  dashboard: async ({ page }, provide) => provide(new DashboardPage(page)),
  envelope: async ({ page }, provide) => provide(new EnvelopePage(page)),
  verify: async ({ page }, provide) => provide(new VerifyPage(page)),
  owner: async ({}, provide) => provide({ ...person("Awa", "Ndiaye"), password: PASSWORD }),
  signedInOwner: async ({ auth, owner }, provide) => {
    await auth.signUp(owner);
    await provide(owner);
  },
  recipientPage: async ({ browser }, provide, testInfo) => {
    const contexts: BrowserContext[] = [];
    const u = testInfo.project.use;
    await provide(async () => {
      const context = await browser.newContext({
        baseURL: u.baseURL,
        viewport: u.viewport,
        userAgent: u.userAgent,
        deviceScaleFactor: u.deviceScaleFactor,
        isMobile: u.isMobile,
        hasTouch: u.hasTouch,
        locale: "fr-FR",
      });
      contexts.push(context);
      return new CeremonyPage(await context.newPage());
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});

export { expect } from "@playwright/test";
