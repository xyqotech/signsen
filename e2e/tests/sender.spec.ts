import { prepareEnvelope, sendEnvelopeTo } from "../flows/envelope.flow";
import { expect, test } from "../fixtures/test";
import { person, samplePdf } from "../support/test-data";

test.describe("Sender — dashboard", () => {
  test("drafts are listed newest first, with their recipients", async ({ signedInOwner, dashboard, envelope }) => {
    void signedInOwner;
    await prepareEnvelope(dashboard, envelope, { title: "Devis Thiès", participants: [{ person: person("Ndeye", "Faye") }] });
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.setDetails("Facture Ziguinchor");
    await dashboard.goto();
    await expect(dashboard.rows()).toHaveCount(2);
    await expect(dashboard.rows().first()).toContainText("Facture Ziguinchor");
    await expect(dashboard.rows().nth(1)).toContainText("Ndeye Faye");
    await expect(dashboard.rows().first()).toContainText("Brouillon");
  });

  test("search matches titles and recipients; filters narrow by status", async ({ signedInOwner, dashboard, envelope }) => {
    void signedInOwner;
    await sendEnvelopeTo(dashboard, envelope, { title: "Bail Mermoz", participants: [{ person: person("Lamine", "Diallo") }] });
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.setDetails("Note interne");

    await dashboard.goto();
    await dashboard.search("lamine");
    await expect(dashboard.rows()).toHaveCount(1);
    await expect(dashboard.rows().first()).toContainText("Bail Mermoz");

    await dashboard.goto();
    await dashboard.filter("En cours");
    await expect(dashboard.rows()).toHaveCount(1);
    await dashboard.filter("Brouillons");
    await expect(dashboard.rows()).toHaveCount(1);
    await expect(dashboard.rows().first()).toContainText("Note interne");
    await dashboard.filter("Terminées");
    await expect(dashboard.emptyState()).toBeVisible();
  });

  test("more than one page of requests is paginated", async ({ signedInOwner, dashboard, page }) => {
    void signedInOwner;
    for (let i = 0; i < 16; i++) {
      await dashboard.goto();
      await dashboard.newEnvelope();
    }
    await dashboard.goto();
    await expect(dashboard.rows()).toHaveCount(15);
    await expect(page.getByText("Page 1 sur 2")).toBeVisible();
    await page.getByRole("link", { name: /Suivant/ }).click();
    await expect(dashboard.rows()).toHaveCount(1);
    await expect(page.getByText("Page 2 sur 2")).toBeVisible();
  });
});

test.describe("Sender — editor", () => {
  test("an incomplete request cannot be sent, and says why", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await page.getByRole("button", { name: "Envoyer pour signature" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Ajoutez un document PDF.");
    await expect(alert).toContainText("Ajoutez au moins un signataire ou un approbateur.");
    await expect(envelope.status()).toHaveText("Brouillon");
  });

  test("a file that is not a PDF is refused", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await page.getByLabel("Choisir un PDF").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
    await page.getByRole("button", { name: "Ajouter le document", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Ce fichier n'est pas un PDF valide.");
    void envelope;
  });

  test("a signer without a box blocks sending", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.upload(await samplePdf());
    await envelope.addRecipient(person("Seynabou", "Mbaye"));
    await page.getByRole("button", { name: "Envoyer pour signature" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Chaque signataire doit avoir au moins une case de signature.");
  });

  test("boxes can be removed, and replacing the document clears them", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    const signer = person("Pape", "Ndiaye");
    await prepareEnvelope(dashboard, envelope, { title: "Contrat", participants: [{ person: signer }] });
    await envelope.placeField(signer.name, 2, 0.3, 0.3);
    await expect(envelope.fields()).toHaveCount(2);
    await envelope.fields().nth(1).getByRole("button", { name: "Supprimer la case" }).click();
    await expect(envelope.fields()).toHaveCount(1);
    await envelope.saveFields();

    await envelope.upload({ ...(await samplePdf({ pages: 3 })), name: "contrat-v2.pdf" });
    await expect(page.getByText("3 pages")).toBeVisible();
    await expect(envelope.fields()).toHaveCount(0);
  });

  test("a box can be nudged with the keyboard and saved", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    const signer = person("Astou", "Seck");
    await prepareEnvelope(dashboard, envelope, { title: "Clavier", participants: [{ person: signer }] });
    const field = envelope.fields().first();
    const before = (await field.boundingBox())!;
    await field.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await field.boundingBox())!.x).toBeLessThan(before.x);
    await envelope.saveFields();
    await page.reload();
    await expect(envelope.fields()).toHaveCount(1);
  });

  test("a draft can be deleted after confirmation", async ({ signedInOwner, dashboard, envelope }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.setDetails("À supprimer");
    await envelope.deleteDraft();
    await expect(dashboard.emptyState()).toBeVisible();
  });
});

test.describe("Sender — tracking", () => {
  test("the sender can resend an invitation: the old link stops working", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage, page }) => {
    void signedInOwner;
    const signer = person("Babacar", "Thiam");
    await sendEnvelopeTo(dashboard, envelope, { title: "Relance", participants: [{ person: signer }] });
    const oldLink = await mailbox.invitationLink(signer.email);
    await envelope.participant(signer.name).getByRole("button", { name: "Renvoyer l'invitation" }).click();
    await expect(page.getByText("Invitation renvoyée.")).toBeVisible();
    await expect.poll(() => mailbox.messagesTo(signer.email).length).toBe(2);
    const newLink = await mailbox.invitationLink(signer.email);
    expect(newLink).not.toBe(oldLink);

    const ceremony = await recipientPage();
    const res = await ceremony.page.goto(oldLink);
    expect(res?.status()).toBe(404);
    await ceremony.open(newLink);
    await expect(ceremony.page.getByRole("button", { name: "Recevoir le code" })).toBeVisible();
  });

  test("cancelling closes the request for everyone", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const signer = person("Rokhaya", "Diouf");
    await sendEnvelopeTo(dashboard, envelope, { title: "À annuler", participants: [{ person: signer }] });
    const link = await mailbox.invitationLink(signer.email);
    await envelope.cancel();
    await mailbox.waitFor(signer.email, (m) => m.subject.startsWith("Annulé"));
    const ceremony = await recipientPage();
    await ceremony.open(link);
    await expect(ceremony.page.getByText("L'expéditeur a annulé cette demande.")).toBeVisible();
    await expect(ceremony.page.getByRole("button", { name: "Recevoir le code" })).toHaveCount(0);
  });
});
