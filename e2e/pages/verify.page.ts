import { expect, type Page } from "@playwright/test";

export class VerifyPage {
  constructor(private readonly page: Page) {}

  async goto(path = "/verify") {
    await this.page.goto(path);
  }

  async check(file: { name: string; mimeType: string; buffer: Buffer }) {
    await this.page.getByLabel("Fichier PDF").setInputFiles(file);
    await this.page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await expect(this.result()).toBeVisible();
  }

  result() {
    return this.page.getByTestId("verify-result");
  }
}
