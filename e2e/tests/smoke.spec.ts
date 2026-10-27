import { expect, test } from "../fixtures/test";

test.describe("Smoke", () => {
  test("the home page presents the service and its honest legal level", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Faites signer vos documents en quelques minutes");
    await expect(page.getByRole("contentinfo")).toContainText("ne délivre pas de signature électronique qualifiée");
    await expect(page.getByRole("link", { name: "Vérifier un document" }).first()).toBeVisible();
  });

  test("every response carries the security headers", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("a new sender signs up and lands on an empty dashboard", async ({ auth, owner, page }) => {
    await auth.signUp(owner);
    await expect(page.getByText("Aucune demande ici pour le moment.")).toBeVisible();
  });
});
