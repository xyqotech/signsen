import fs from "node:fs";
import { expect, type Page } from "@playwright/test";

export type Role = "signer" | "approver" | "viewer";

export class EnvelopePage {
  constructor(readonly page: Page) {}

  /** Reloads the current envelope (after recipients acted elsewhere). */
  async reload() {
    await this.page.reload();
  }

  async open(url: string) {
    await this.page.goto(url);
  }

  status() {
    return this.page.getByRole("heading", { level: 1 }).locator("..").locator("[data-status]");
  }

  // ─── Draft ────────────────────────────────────────────────────────────────

  async setDetails(title: string, message = "") {
    await this.page.getByLabel("Titre", { exact: true }).fill(title);
    await this.page.getByLabel(/Message aux destinataires/).fill(message);
    await this.page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(this.page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  }

  async upload(file: { name: string; mimeType: string; buffer: Buffer }) {
    const replacing = await this.page.getByRole("button", { name: "Remplacer", exact: true }).isVisible();
    await this.page.getByLabel(replacing ? "Remplacer le document" : "Choisir un PDF").setInputFiles(file);
    await this.page.getByRole("button", { name: replacing ? "Remplacer" : "Ajouter le document", exact: true }).click();
    await expect(this.page.getByRole("link", { name: file.name })).toBeVisible();
  }

  async addRecipient(p: { name: string; email: string }, role: Role = "signer", order = 1) {
    const form = this.page.getByRole("button", { name: "Ajouter", exact: true }).locator("xpath=ancestor::form");
    await form.getByLabel("Nom complet", { exact: true }).fill(p.name);
    await form.getByLabel("Adresse e-mail", { exact: true }).fill(p.email);
    await form.getByLabel("Rôle", { exact: true }).selectOption(role);
    await form.getByLabel("Ordre", { exact: true }).fill(String(order));
    await form.getByRole("button", { name: "Ajouter", exact: true }).click();
    await expect(this.page.getByTestId("recipient-list")).toContainText(p.email.toLowerCase());
  }

  /** Picks the signer, then clicks the rendered page at (x, y) given as ratios. */
  async placeField(signerName: string, pageNumber = 1, x = 0.6, y = 0.82) {
    await this.page.getByRole("button", { name: new RegExp(`^${signerName}`) }).click();
    const overlay = this.page.getByTestId(`page-overlay-${pageNumber}`);
    await expect(overlay).toBeVisible();
    const box = (await overlay.boundingBox())!;
    // A positioned click scrolls the target point into view first (pages are taller than the viewport).
    await overlay.click({ position: { x: x * box.width, y: y * box.height } });
  }

  fields() {
    return this.page.getByTestId("field");
  }

  async saveFields() {
    await this.page.getByTestId("save-fields").click();
    await expect(this.page.getByText("Cases enregistrées.")).toBeVisible();
  }

  async send() {
    await this.page.getByRole("button", { name: "Envoyer pour signature" }).click();
    await expect(this.status()).toHaveText("En cours");
  }

  async deleteDraft() {
    this.page.once("dialog", (d) => d.accept());
    await this.page.getByRole("button", { name: "Supprimer le brouillon" }).click();
    await expect(this.page).toHaveURL(/\/envelopes$/);
  }

  // ─── Tracking ─────────────────────────────────────────────────────────────

  participant(name: string) {
    return this.page.getByTestId("participants").getByRole("listitem").filter({ hasText: name });
  }

  async cancel() {
    this.page.once("dialog", (d) => d.accept());
    await this.page.getByRole("button", { name: "Annuler la demande" }).click();
    await expect(this.status()).toHaveText("Annulée");
  }

  async downloadFinal(): Promise<Buffer> {
    const [download] = await Promise.all([this.page.waitForEvent("download"), this.page.getByTestId("download-final").click()]);
    return fs.readFileSync((await download.path())!);
  }
}
