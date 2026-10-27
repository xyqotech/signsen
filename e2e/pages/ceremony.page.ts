import fs from "node:fs";
import { expect, type Page } from "@playwright/test";

/** The signing flow a recipient follows from their invitation link (no account). */
export class CeremonyPage {
  constructor(readonly page: Page) {}

  async open(link: string) {
    await this.page.goto(link);
    await expect(this.page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  myFields() {
    return this.page.getByTestId("my-field");
  }

  async requestCode() {
    await this.page.getByRole("button", { name: /Recevoir le code|Renvoyer un code/ }).click();
    await expect(this.page.getByText("Code envoyé. Il est valable 10 minutes.")).toBeVisible();
  }

  async fillCode(code: string) {
    await this.page.getByLabel("Code à 6 chiffres").fill(code);
  }

  /** Draws a short scribble on the signature pad. */
  async drawSignature() {
    const canvas = this.page.getByTestId("signature-canvas");
    await expect(canvas).toBeVisible();
    // Pages growing as they render would move the pad mid-stroke (one column on phones).
    await expect(this.page.locator("[data-page]").first()).toBeVisible();
    await expect(this.page.locator("[data-page]:not([data-ready])")).toHaveCount(0);
    // Mouse events outside the viewport are dropped: bring the pad on screen first.
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    const y = box.y + box.height * 0.55;
    await this.page.mouse.move(box.x + 30, y);
    await this.page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await this.page.mouse.move(box.x + 30 + i * 16, y + Math.sin(i) * 18, { steps: 2 });
    }
    await this.page.mouse.up();
  }

  async typeSignature(name: string) {
    await this.page.getByRole("tab", { name: "Saisir" }).click();
    await this.page.getByPlaceholder("Tapez votre nom").fill(name);
  }

  async consent() {
    await this.page.getByRole("checkbox").check();
  }

  async sign() {
    await this.page.getByRole("button", { name: "Signer", exact: true }).click();
  }

  async approve() {
    await this.page.getByRole("button", { name: "Approuver", exact: true }).click();
  }

  async decline(code: string, reason: string) {
    await this.page.getByRole("button", { name: "Refuser", exact: true }).click();
    await this.page.getByLabel("Code à 6 chiffres").fill(code);
    await this.page.getByLabel("Motif du refus").fill(reason);
    await this.page.getByRole("button", { name: "Confirmer le refus" }).click();
  }

  notice() {
    const main = this.page.getByRole("main");
    return main.getByRole("status").or(main.getByRole("alert"));
  }

  async download(): Promise<Buffer> {
    const [download] = await Promise.all([this.page.waitForEvent("download"), this.page.getByTestId("ceremony-download").click()]);
    return fs.readFileSync((await download.path())!);
  }
}
