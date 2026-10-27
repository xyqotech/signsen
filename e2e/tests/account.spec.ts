import { expect, test } from "../fixtures/test";

test.describe("Account", () => {
  test("a sender who forgot the password chooses a new one from the e-mailed link", async ({ signedInOwner, auth, mailbox, page, browser }) => {
    const newPassword = "un tout nouveau mot de passe 7";
    // Another device stays signed in: the reset must close that session too.
    const elsewhere = await browser.newContext({ storageState: await page.context().storageState() });
    const otherDevice = await elsewhere.newPage();

    await auth.signOut();
    await auth.requestPasswordReset(signedInOwner.email);
    const link = await mailbox.resetLink(signedInOwner.email);
    await auth.resetPassword(link, newPassword);
    await mailbox.waitFor(signedInOwner.email, (m) => m.subject === "Votre mot de passe a été modifié");

    await otherDevice.goto("/envelopes");
    await expect(otherDevice).toHaveURL(/\/login$/);
    await elsewhere.close();

    await auth.signIn({ email: signedInOwner.email, password: signedInOwner.password }, { expectSuccess: false });
    await expect(auth.error()).toHaveText("Adresse ou mot de passe incorrect.");
    await auth.signIn({ email: signedInOwner.email, password: newPassword });

    await page.goto(link);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Ce lien n'est plus valide");
  });

  test("an unknown address gets the same answer and no e-mail", async ({ auth, owner, mailbox }) => {
    await auth.requestPasswordReset(owner.email);
    expect(mailbox.messagesTo(owner.email)).toHaveLength(0);
  });
});
