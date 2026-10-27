import { actFromEmail, sendEnvelopeTo } from "../flows/envelope.flow";
import { AuthPage } from "../pages/auth.page";
import { expect, test } from "../fixtures/test";
import { PASSWORD, person, samplePdf } from "../support/test-data";

test.describe("Decline", () => {
  test("a recipient declines with a reason; the sender sees it, the others are only told it is closed", async ({
    signedInOwner,
    dashboard,
    envelope,
    mailbox,
    recipientPage,
  }) => {
    const a = person("Alioune", "Cisse");
    const b = person("Coumba", "Sarr");
    await sendEnvelopeTo(dashboard, envelope, { title: "Offre commerciale", participants: [{ person: a }, { person: b }] });
    const bLink = await mailbox.invitationLink(b.email);

    const ceremony = await recipientPage();
    await ceremony.open(await mailbox.invitationLink(a.email));
    const before = mailbox.messagesTo(a.email).length;
    await ceremony.requestCode();
    await ceremony.decline(await mailbox.nextCode(a.email, before), "Le montant ne correspond pas au devis.");
    await expect(ceremony.page.getByText("Vous avez refusé ce document.")).toBeVisible();

    const ownerMail = await mailbox.waitFor(signedInOwner.email, (m) => m.subject.startsWith("Refusé"));
    expect(ownerMail.text).toContain("Le montant ne correspond pas au devis.");
    const otherMail = await mailbox.waitFor(b.email, (m) => m.subject.startsWith("Refusé"));
    expect(otherMail.text).not.toContain("Le montant ne correspond pas au devis.");

    await envelope.reload();
    await expect(envelope.status()).toHaveText("Refusée");
    await expect(envelope.participant(a.name)).toContainText("Le montant ne correspond pas au devis.");

    const other = await recipientPage();
    await other.open(bLink);
    await expect(other.page.getByText("Cette demande a été refusée et close.")).toBeVisible();
  });
});

test.describe("Access control", () => {
  test("private pages require a session", async ({ page }) => {
    await page.goto("/envelopes");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("another account cannot see a request nor its document", async ({ signedInOwner, dashboard, envelope, browser, baseURL }) => {
    void signedInOwner;
    const url = await sendEnvelopeTo(dashboard, envelope, { title: "Confidentiel", participants: [{ person: person("Idrissa", "Gaye") }] });

    const intruderContext = await browser.newContext({ baseURL, locale: "fr-FR" });
    const intruder = await intruderContext.newPage();
    await new AuthPage(intruder).signUp({ ...person("Intrus", "Test"), password: PASSWORD });
    expect((await intruder.goto(url))?.status()).toBe(404);
    expect((await intruder.request.get(`${url}/document`)).status()).toBe(404);
    expect((await intruderContext.request.get(`${url}/document`)).status()).toBe(404);
    await intruderContext.close();

    const anonymous = await browser.newContext({ baseURL });
    expect((await anonymous.request.get(`${url}/document`)).status()).toBe(401);
    await anonymous.close();
  });

  test("an unknown signing link is a 404", async ({ page }) => {
    expect((await page.goto(`/s/${"A".repeat(43)}`))?.status()).toBe(404);
    expect((await page.request.get(`/s/${"A".repeat(43)}/document`)).status()).toBe(404);
  });

  test("a wrong password is refused and the e-mail stays typed", async ({ auth, owner, page }) => {
    await auth.signUp(owner);
    await auth.signOut();
    await auth.signIn({ email: owner.email, password: "pas le bon mot de passe" }, { expectSuccess: false });
    await expect(auth.error()).toHaveText("Adresse ou mot de passe incorrect.");
    await expect(page.getByLabel("Adresse e-mail")).toHaveValue(owner.email);
  });
});

test.describe("Verification", () => {
  test("a sealed PDF modified afterwards is detected; an unsigned one is unknown; the QR page masks e-mails", async ({
    signedInOwner,
    dashboard,
    envelope,
    mailbox,
    recipientPage,
    verify,
    page,
  }) => {
    void signedInOwner;
    const signer = person("Daouda", "Mane");
    const url = await sendEnvelopeTo(dashboard, envelope, { title: "Attestation de travail", participants: [{ person: signer }] });
    await actFromEmail(await recipientPage(), mailbox, signer, "draw");
    await envelope.reload();
    const sealed = await envelope.downloadFinal();

    await verify.goto();
    await verify.check({ name: "altered.pdf", mimeType: "application/pdf", buffer: Buffer.concat([sealed, Buffer.from("\n%%EOF\n")]) });
    await expect(verify.result()).toContainText("Document non reconnu ou modifié");
    await expect(verify.result()).toContainText("Des données ont été ajoutées après le scellement.");

    await verify.goto();
    await verify.check(await samplePdf());
    await expect(verify.result()).toContainText("Aucun sceau trouvé dans ce fichier.");

    const id = url.split("/").pop()!;
    await page.goto(`/verify/${id}`);
    await expect(page.getByRole("heading", { name: "Attestation de travail" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Daouda Mane");
    await expect(page.getByRole("main")).not.toContainText(signer.email);
    await expect(page.getByRole("main")).toContainText("@e2e.test");
  });
});

test.describe("Languages", () => {
  test("the interface switches to English and remembers it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Langue" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get your documents signed in minutes");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByRole("button", { name: "Language" }).click();
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  });
});
