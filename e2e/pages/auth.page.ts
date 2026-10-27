import { expect, type Page } from "@playwright/test";

export class AuthPage {
  constructor(private readonly page: Page) {}

  async signUp(user: { name: string; email: string; password: string }) {
    await this.page.goto("/signup");
    await this.page.getByLabel("Nom complet").fill(user.name);
    await this.page.getByLabel("Adresse e-mail").fill(user.email);
    await this.page.getByLabel("Mot de passe").fill(user.password);
    await this.page.getByRole("button", { name: "Créer un compte" }).click();
    await expect(this.page).toHaveURL(/\/envelopes$/);
  }

  async signIn(user: { email: string; password: string }, { expectSuccess = true } = {}) {
    await this.page.goto("/login");
    await this.page.getByLabel("Adresse e-mail").fill(user.email);
    await this.page.getByLabel("Mot de passe").fill(user.password);
    await this.page.getByRole("main").getByRole("button", { name: "Se connecter" }).click();
    if (expectSuccess) await expect(this.page).toHaveURL(/\/envelopes$/);
  }

  async signOut() {
    await this.page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(this.page).toHaveURL(/\/login$/);
  }

  error() {
    // Next adds its own route announcer with role="alert": look inside <main> only.
    return this.page.getByRole("main").getByRole("alert");
  }
}
