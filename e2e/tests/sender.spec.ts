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

/** The application's own scripts: until they run, nothing reacts to what the user does. */
const SCRIPTS = /\/_next\/static\/.+\.js(\?.*)?$/;

test.describe("Sender — editor", () => {
  test("an incomplete request cannot be sent, and says why", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await page.getByRole("button", { name: "Envoyer pour signature" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Donnez un titre à la demande");
    await expect(alert).toContainText("Ajoutez un document PDF.");
    await expect(alert).toContainText("Ajoutez au moins un signataire ou un approbateur.");
    await expect(envelope.status()).toHaveText("Brouillon");
  });

  test("a file that is not a PDF is refused", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.chooseDocument({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Ce fichier n'est pas un PDF valide.");
    // The refused file does not stay next to the button as if it had been added.
    await expect(envelope.documentInput()).toHaveValue("");
    await expect(envelope.document("notes.pdf")).toHaveCount(0);
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

  test("a chosen PDF is uploaded without another click, and the request can be sent", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.setDetails("Bon de commande");
    const pdf = await samplePdf();
    // Nothing else is touched in the document section.
    await envelope.chooseDocument(pdf);
    await envelope.addRecipient(person("Khady", "Sarr"), "approver");
    await envelope.send();
    await expect(page.getByRole("link", { name: "Document d'origine" })).toBeVisible();
  });

  test("the upload says what it did, and the keyboard focus stays on the file field", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    const pdf = await samplePdf();
    await envelope.documentInput().focus();
    await envelope.chooseDocument(pdf);
    await expect(page.getByRole("status").filter({ hasText: "Document ajouté." })).toBeVisible();
    await expect(envelope.document(pdf.name)).toBeVisible();
    await expect(envelope.documentInput()).toBeFocused();
    await expect(page.getByRole("button", { name: "Ajouter le document" })).toHaveCount(0);
  });

  test("replacing a document asks first: declining keeps the document and its boxes", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    const signer = person("Coumba", "Gueye");
    await prepareEnvelope(dashboard, envelope, { title: "Mandat", participants: [{ person: signer }] });
    let question = "";
    page.once("dialog", (d) => {
      question = d.message();
      void d.dismiss();
    });
    await envelope.chooseDocument({ ...(await samplePdf({ pages: 3 })), name: "mandat-v2.pdf" });
    expect(question).toContain("contrat-prestation.pdf");
    expect(question).toContain("mandat-v2.pdf");
    expect(question).toContain("Les cases de signature déjà placées seront effacées.");
    await expect(envelope.documentInput()).toHaveValue("");
    await page.reload();
    await expect(envelope.document("contrat-prestation.pdf")).toBeVisible();
    await expect(page.getByText("2 pages")).toBeVisible();
    await expect(envelope.fields()).toHaveCount(1);
  });

  test("a title typed without clicking Save is the one the signer sees", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const signer = person("Ibrahima", "Fall");
    await dashboard.goto();
    await dashboard.newEnvelope();
    // "Enregistrer" is never clicked.
    await envelope.typeDetails("Contrat de bail Mermoz", "Merci de signer avant vendredi.");
    await envelope.upload(await samplePdf());
    await envelope.addRecipient(signer);
    await envelope.placeField(signer.name);
    await envelope.saveFields();
    await envelope.send();

    const invitation = await mailbox.waitFor(signer.email, (m) => /\/s\/[A-Za-z0-9_-]{43}/.test(m.text));
    expect(invitation.subject).toContain("« Contrat de bail Mermoz »");
    expect(invitation.subject).not.toContain("Nouvelle demande");
    const ceremony = await recipientPage();
    await ceremony.open(await mailbox.invitationLink(signer.email));
    await expect(ceremony.page.getByRole("heading", { level: 1 })).toHaveText("Contrat de bail Mermoz");
    await expect(ceremony.page.getByText("Merci de signer avant vendredi.")).toBeVisible();
    await expect(ceremony.page.getByText("Nouvelle demande")).toHaveCount(0);
  });

  test("the title is saved when the field loses focus, and says so", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.typeDetails("Procès-verbal de réception");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("status").filter({ hasText: "Enregistré." })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Procès-verbal de réception");
    // The save did not move the focus: Tab went to the next field and stayed there.
    await expect(page.getByLabel(/Message aux destinataires/)).toBeFocused();
    // Leaving the message for the Save button saves it too, and the button keeps the focus while it does.
    await page.getByLabel(/Message aux destinataires/).fill("À retourner avant vendredi.");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("status").filter({ hasText: "Enregistré." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toBeFocused();
    await page.reload();
    await expect(envelope.titleField()).toHaveValue("Procès-verbal de réception");
    await expect(page.getByLabel(/Message aux destinataires/)).toHaveValue("À retourner avant vendredi.");
  });

  test("a title typed just before leaving the editor is saved", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.typeDetails("Lettre de mission");
    // The click takes the focus away from the title and leaves the page at once.
    await page.getByRole("main").getByRole("link", { name: /Mes demandes/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Mes demandes" })).toBeVisible();
    await expect(dashboard.rows().first()).toContainText("Lettre de mission");
  });

  test("sending saves a title still being typed, even when the focus never left the field", async ({ signedInOwner, dashboard, envelope, mailbox, page }) => {
    void signedInOwner;
    const approver = person("Mariama", "Ba");
    await prepareEnvelope(dashboard, envelope, { title: "Premier jet", participants: [{ person: approver, role: "approver" }] });
    await envelope.typeDetails("Avenant n° 2");
    // A tap that does not move the focus (some phones): the field never loses it, nothing was saved yet.
    await envelope.sendButton().dispatchEvent("click");
    await expect(envelope.status()).toHaveText("En cours");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Avenant n° 2");
    const invitation = await mailbox.waitFor(approver.email, (m) => /\/s\/[A-Za-z0-9_-]{43}/.test(m.text));
    expect(invitation.subject).toContain("« Avenant n° 2 »");
  });

  test("a refused sending still keeps the title typed with it", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.typeDetails("Convention de stage");
    await envelope.sendButton().dispatchEvent("click");
    await expect(envelope.sendProblems().getByRole("listitem")).toHaveText(["Ajoutez un document PDF.", "Ajoutez au moins un signataire ou un approbateur."]);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Convention de stage");
    await expect(envelope.status()).toHaveText("Brouillon");
  });

  test("an emptied title is not sent: the field says so", async ({ signedInOwner, dashboard, envelope }) => {
    void signedInOwner;
    await prepareEnvelope(dashboard, envelope, { title: "Devis", participants: [{ person: person("Aliou", "Cisse"), role: "approver" }] });
    await envelope.typeDetails("");
    await envelope.sendButton().click();
    await expect(envelope.titleField()).toBeFocused();
    expect(await envelope.titleField().evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await envelope.reload();
    await expect(envelope.status()).toHaveText("Brouillon");
    await expect(envelope.titleField()).toHaveValue("Devis");
  });

  test("a request still named by its placeholder title cannot be sent", async ({ signedInOwner, dashboard, envelope }) => {
    void signedInOwner;
    await dashboard.goto();
    await dashboard.newEnvelope();
    await envelope.upload(await samplePdf());
    await envelope.addRecipient(person("Oumar", "Sy"), "approver");
    await envelope.sendButton().click();
    await expect(envelope.sendProblems().getByRole("listitem")).toHaveText(["Donnez un titre à la demande : c'est lui que verront vos destinataires."]);
    await expect(envelope.status()).toHaveText("Brouillon");
    await envelope.typeDetails("Ordre de mission");
    await envelope.send();
  });

  test("a PDF chosen before the application scripts are loaded is uploaded once they are", async ({ signedInOwner, dashboard, envelope, page }) => {
    void signedInOwner;
    await dashboard.goto();
    const url = await dashboard.newEnvelope();
    let release = () => {};
    const loaded = new Promise<void>((resolve) => (release = resolve));
    await page.route(SCRIPTS, async (route) => {
      await loaded;
      await route.continue();
    });
    await page.goto(url, { waitUntil: "commit" });
    const pdf = await samplePdf();
    await envelope.chooseDocument(pdf);
    await expect(envelope.document(pdf.name)).toHaveCount(0);
    release();
    await expect(envelope.document(pdf.name)).toBeVisible();
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
