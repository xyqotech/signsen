import { actFromEmail, sendEnvelopeTo } from "../flows/envelope.flow";
import { expect, test } from "../fixtures/test";
import { person } from "../support/test-data";

test.describe("Signing ceremony", () => {
  test("a sequential request goes signer → approver → copy, and ends with a sealed PDF", async ({
    signedInOwner,
    dashboard,
    envelope,
    mailbox,
    recipientPage,
    verify,
  }) => {
    const moussa = person("Moussa", "Sow");
    const fatou = person("Fatou", "Diop");
    const compta = person("Compta", "Acme");
    await sendEnvelopeTo(dashboard, envelope, {
      title: "Contrat de prestation 2026",
      message: "Merci de signer avant vendredi.",
      participants: [
        { person: moussa, role: "signer", order: 1 },
        { person: fatou, role: "approver", order: 2 },
        { person: compta, role: "viewer", order: 3 },
      ],
    });

    // Only the first routing order is invited.
    expect(mailbox.messagesTo(moussa.email)).toHaveLength(1);
    expect(mailbox.messagesTo(fatou.email)).toHaveLength(0);
    await expect(envelope.participant(moussa.name)).toContainText("Invité");
    await expect(envelope.participant(fatou.name)).toContainText("En attente de son tour");

    const moussaPage = await recipientPage();
    await moussaPage.open(await mailbox.invitationLink(moussa.email));
    await expect(moussaPage.page.getByText("Merci de signer avant vendredi.")).toBeVisible();
    await expect(moussaPage.page.getByText(signedInOwner.name).first()).toBeVisible();
    await expect(moussaPage.myFields()).toHaveCount(1);
    await actFromEmail(moussaPage, mailbox, moussa, "draw");

    // Signing unlocks the next order.
    const fatouPage = await recipientPage();
    await actFromEmail(fatouPage, mailbox, fatou, "approve");

    // Everyone, the copy recipient included, receives the final document.
    for (const who of [moussa, fatou, compta]) {
      const done = await mailbox.waitFor(who.email, (m) => m.subject.startsWith("Terminé"));
      expect(done.attachments[0]).toMatchObject({ filename: "contrat-prestation (signed).pdf", contentType: "application/pdf" });
    }
    await mailbox.waitFor(signedInOwner.email, (m) => m.subject.startsWith("Terminé"));

    await envelope.reload();
    await expect(envelope.status()).toHaveText("Terminée");
    await expect(envelope.participant(moussa.name)).toContainText("A signé");
    await expect(envelope.participant(fatou.name)).toContainText("A approuvé");
    await expect(envelope.page.getByTestId("history")).toContainText("Document final scellé");

    const sealed = await envelope.downloadFinal();
    await verify.goto();
    await verify.check({ name: "signed.pdf", mimeType: "application/pdf", buffer: sealed });
    await expect(verify.result()).toContainText("Document authentique et intact");
    await expect(verify.result()).toContainText("Contrat de prestation 2026");
    await expect(verify.result()).toContainText("Moussa Sow");
    await expect(verify.result()).not.toContainText(moussa.email);

    // The recipient can download the same sealed file from their link.
    await moussaPage.open(await mailbox.invitationLink(moussa.email));
    await expect(moussaPage.page.getByText("Tout le monde a agi")).toBeVisible();
    expect((await moussaPage.download()).equals(sealed)).toBe(true);
  });

  test("a typed signature is accepted", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const aminata = person("Aminata", "Ba");
    await sendEnvelopeTo(dashboard, envelope, { title: "Bon de commande", participants: [{ person: aminata }] });
    await actFromEmail(await recipientPage(), mailbox, aminata, "type");
    await envelope.reload();
    await expect(envelope.status()).toHaveText("Terminée");
  });

  test("recipients of the same order are invited in parallel", async ({ signedInOwner, dashboard, envelope, mailbox }) => {
    void signedInOwner;
    const a = person("Ibrahima", "Fall");
    const b = person("Khady", "Ndoye");
    await sendEnvelopeTo(dashboard, envelope, { title: "Procès-verbal", participants: [{ person: a }, { person: b }] });
    await mailbox.invitationLink(a.email);
    await mailbox.invitationLink(b.email);
  });

  test("a wrong code is refused and the right one still works", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const signer = person("Ousmane", "Kane");
    await sendEnvelopeTo(dashboard, envelope, { title: "Avenant", participants: [{ person: signer }] });
    const ceremony = await recipientPage();
    await ceremony.open(await mailbox.invitationLink(signer.email));
    const before = mailbox.messagesTo(signer.email).length;
    await ceremony.requestCode();
    const code = await mailbox.nextCode(signer.email, before);
    await ceremony.fillCode(code === "000000" ? "111111" : "000000");
    await ceremony.drawSignature();
    await ceremony.consent();
    await ceremony.sign();
    await expect(ceremony.page.getByRole("main").getByRole("alert")).toHaveText("Code incorrect.");
    await ceremony.fillCode(code);
    await ceremony.sign();
    await expect(ceremony.page.getByText("Merci, votre signature est enregistrée.")).toBeVisible();
  });

  test("without consent nothing is signed, and the code is not burned", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const signer = person("Mariama", "Sy");
    await sendEnvelopeTo(dashboard, envelope, { title: "Mandat", participants: [{ person: signer }] });
    const ceremony = await recipientPage();
    await ceremony.open(await mailbox.invitationLink(signer.email));
    const before = mailbox.messagesTo(signer.email).length;
    await ceremony.requestCode();
    await ceremony.fillCode(await mailbox.nextCode(signer.email, before));
    await ceremony.drawSignature();
    await ceremony.sign();
    await expect(ceremony.page.getByRole("main").getByRole("alert")).toHaveText("Cochez la case de consentement pour continuer.");
    await ceremony.consent();
    await ceremony.sign();
    await expect(ceremony.page.getByText("Merci, votre signature est enregistrée.")).toBeVisible();
  });

  test("the Sign button stays disabled until a signature is drawn", async ({ signedInOwner, dashboard, envelope, mailbox, recipientPage }) => {
    void signedInOwner;
    const signer = person("Cheikh", "Gueye");
    await sendEnvelopeTo(dashboard, envelope, { title: "Attestation", participants: [{ person: signer }] });
    const ceremony = await recipientPage();
    await ceremony.open(await mailbox.invitationLink(signer.email));
    const sign = ceremony.page.getByRole("button", { name: "Signer", exact: true });
    await expect(sign).toBeDisabled();
    await ceremony.drawSignature();
    await expect(sign).toBeEnabled();
    await ceremony.page.getByRole("button", { name: "Effacer" }).click();
    await expect(sign).toBeDisabled();
  });
});
