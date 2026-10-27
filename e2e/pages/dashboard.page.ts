import { expect, type Page } from "@playwright/test";

export class DashboardPage {
  constructor(private readonly page: Page) {}

  async goto(query = "") {
    await this.page.goto(`/envelopes${query}`);
    await expect(this.page.getByRole("heading", { level: 1, name: "Mes demandes" })).toBeVisible();
  }

  /** Creates an empty draft and lands on its editor; returns the envelope URL. */
  async newEnvelope(): Promise<string> {
    await this.page.getByRole("button", { name: /Nouvelle demande/ }).click();
    await expect(this.page).toHaveURL(/\/envelopes\/[0-9a-f-]{36}$/);
    return this.page.url();
  }

  async search(term: string) {
    const box = this.page.getByRole("searchbox").or(this.page.getByPlaceholder(/Rechercher/));
    await box.fill(term);
    await box.press("Enter");
    await expect(this.page).toHaveURL(new RegExp(`q=${encodeURIComponent(term).replace(/%20/g, "\\+")}`));
  }

  async filter(label: string) {
    await this.page.getByRole("link", { name: label, exact: true }).click();
  }

  rows() {
    return this.page.getByTestId("envelope-list").getByRole("link");
  }

  emptyState() {
    return this.page.getByText("Aucune demande ici pour le moment.");
  }
}
