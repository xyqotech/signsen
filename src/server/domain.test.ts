import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import { listEvents, verifyChain } from "./audit";
import {
  requestPasswordReset,
  RESET_TTL_MS,
  resetLinkValid,
  resetPassword,
  SESSION_TTL_MS,
  signIn,
  signOut,
  signUp,
  userForSession,
  type PublicUser,
} from "./auth";
import { act, ceremonyDocument, decline, openCeremony, OTP_MAX_ATTEMPTS, OTP_TTL_MS, requestCode } from "./ceremony";
import {
  addRecipient,
  attachDocument,
  cancelEnvelope,
  createEnvelope,
  deleteEnvelope,
  getEnvelope,
  listEnvelopes,
  removeRecipient,
  resendInvitation,
  sendEnvelope,
  setFields,
  updateEnvelope,
} from "./envelopes";
import { isDomainError, type ErrorCode } from "./errors";
import { checkPdfStructure, PdfStructureError } from "./pdf/structure";
import { catalogRedefinedAtGeneration1, withOneWrongOffset } from "./pdf/testing";
import { verifySeal } from "./pdf/verify";
import { makeTestServices, samplePdf, type TestKit } from "./testing";
import { maskEmail, publicEnvelope, verifyUpload } from "./verification";

const fails = (code: ErrorCode) => (e: unknown) => isDomainError(e, code);

async function expectCode(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toSatisfy(fails(code));
}

/** The error codes of the calls that failed, the others being fulfilled. */
function failures(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) => (r.status === "rejected" ? [isDomainError(r.reason) ? r.reason.code : String(r.reason)] : []));
}

let k: TestKit;
beforeEach(async () => {
  k = await makeTestServices({ APP_NAME: "Acme" });
});
afterEach(() => k.cleanup());

async function owner(email = "awa@acme.test", name = "Awa Ndiaye"): Promise<PublicUser> {
  return signUp(k.s, { email, name, password: "a long password 42", locale: "fr" });
}

function linkFor(email: string): string {
  const mail = k.mailer.last(email);
  const m = mail?.text.match(/\/s\/([A-Za-z0-9_-]{43})/);
  if (!m) throw new Error(`no invitation link for ${email}`);
  return m[1];
}

function codeFor(email: string): string {
  const m = k.mailer.last(email)?.text.match(/(\d{6})/);
  if (!m) throw new Error(`no code for ${email}`);
  return m[1];
}

const signature = async () => ({ kind: "drawn" as const, png: await QRCode.toBuffer("my signature", { width: 160 }) });

/** Owner + envelope with a document (2 pages unless given) and the given recipients, signers with one field each. */
async function readyEnvelope(
  people: { name: string; email: string; role?: "signer" | "approver" | "viewer"; routingOrder?: number }[],
  document?: Buffer,
) {
  const u = await owner();
  const env = await createEnvelope(k.s, u.id, { title: "Contrat de prestation", message: "Merci de signer avant vendredi." });
  await attachDocument(k.s, u.id, env.id, { name: "contrat.pdf", bytes: document ?? (await samplePdf()) });
  const recipients = [];
  for (const p of people) recipients.push(await addRecipient(k.s, u.id, env.id, { role: "signer", ...p }));
  await setFields(
    k.s,
    u.id,
    env.id,
    recipients
      .filter((r) => r.role === "signer")
      .map((r, i) => ({ recipientId: r.id, page: 1, x: 0.1, y: 0.6 + i * 0.1, width: 0.3, height: 0.08 })),
  );
  return { u, env, recipients };
}

async function signAs(email: string) {
  const token = linkFor(email);
  await requestCode(k.s, token);
  await act(k.s, token, { code: codeFor(email), consent: true, signature: await signature() }, { ip: "198.51.100.9", userAgent: "TestBrowser/1" });
  return token;
}

describe("accounts", () => {
  it("signs up with a normalised e-mail and refuses duplicates", async () => {
    const u = await signUp(k.s, { email: "Awa@Acme.TEST", name: " Awa ", password: "a long password 42", locale: "fr" });
    expect(u).toMatchObject({ email: "awa@acme.test", name: "Awa" });
    await expectCode(signUp(k.s, { email: "awa@acme.test", name: "x", password: "a long password 42", locale: "en" }), "email_taken");
  });

  it("creates one account when the same address signs up twice at once", async () => {
    const attempt = (name: string) => signUp(k.s, { email: "awa@acme.test", name, password: "a long password 42", locale: "fr" });
    await k.warm();
    const results = await Promise.allSettled([attempt("Awa"), attempt("Awa bis"), attempt("Awa ter")]);
    expect(failures(results)).toEqual(["email_taken", "email_taken"]);
    const { rows } = await k.s.pool.query("select count(*)::int as n from users");
    expect(rows[0].n).toBe(1);
  });

  it("refuses short passwords and closed signups", async () => {
    await expectCode(signUp(k.s, { email: "a@b.test", name: "A", password: "short", locale: "fr" }), "validation");
    const closed = await makeTestServices({ ALLOW_SIGNUP: "false" });
    try {
      await expectCode(signUp(closed.s, { email: "a@b.test", name: "A", password: "a long password 42", locale: "fr" }), "signup_disabled");
    } finally {
      await closed.cleanup();
    }
  });

  it("signs in, resolves the session, expires it and signs out", async () => {
    await owner();
    const { token } = await signIn(k.s, { email: "AWA@acme.test", password: "a long password 42" });
    expect((await userForSession(k.s, token))?.email).toBe("awa@acme.test");
    await signOut(k.s, token);
    expect(await userForSession(k.s, token)).toBeNull();

    const second = await signIn(k.s, { email: "awa@acme.test", password: "a long password 42" });
    k.advance(SESSION_TTL_MS + 1);
    expect(await userForSession(k.s, second.token)).toBeNull();
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await owner();
    await expectCode(signIn(k.s, { email: "awa@acme.test", password: "wrong password!!" }), "invalid_credentials");
    await expectCode(signIn(k.s, { email: "nobody@acme.test", password: "a long password 42" }), "invalid_credentials");
  });

  it("throttles sign-ins per IP address across accounts", async () => {
    const strict = await makeTestServices({ SIGNIN_IP_LIMIT: "2" });
    try {
      for (const e of ["a@x.test", "b@x.test"]) {
        await expectCode(signIn(strict.s, { email: e, password: "whatever password" }, { ip: "198.51.100.7" }), "invalid_credentials");
      }
      await expectCode(signIn(strict.s, { email: "c@x.test", password: "whatever password" }, { ip: "198.51.100.7" }), "rate_limited");
      await expectCode(signIn(strict.s, { email: "c@x.test", password: "whatever password" }, { ip: "198.51.100.8" }), "invalid_credentials");
    } finally {
      await strict.cleanup();
    }
  });

  it("throttles repeated sign-in attempts on one account", async () => {
    await owner();
    for (let i = 0; i < 10; i++) {
      await expectCode(signIn(k.s, { email: "awa@acme.test", password: "wrong password!!" }), "invalid_credentials");
    }
    await expectCode(signIn(k.s, { email: "awa@acme.test", password: "a long password 42" }), "rate_limited");
  });
});

describe("password reset", () => {
  const NEW_PASSWORD = "a brand new passphrase 7";

  function resetLinkFor(email: string): string {
    const m = k.mailer.last(email)?.text.match(/\/reset\/([A-Za-z0-9_-]{43})/);
    if (!m) throw new Error(`no reset link for ${email}`);
    return m[1];
  }

  it("mails a personal link to a known account and answers the same for an unknown one", async () => {
    await owner();
    await requestPasswordReset(k.s, { email: " AWA@acme.test " });
    const mail = k.mailer.last("awa@acme.test");
    expect(mail?.subject).toMatch(/mot de passe/i);
    expect(mail?.text).toContain("http://signsen.test/reset/");
    expect(mail?.text).toMatch(/1 heure/);
    expect(await resetLinkValid(k.s, resetLinkFor("awa@acme.test"))).toBe(true);

    await expect(requestPasswordReset(k.s, { email: "nobody@acme.test" })).resolves.toBeUndefined();
    expect(k.mailer.to("nobody@acme.test")).toHaveLength(0);
  });

  it("changes the password, signs out every session and warns the owner", async () => {
    await owner();
    const before = await signIn(k.s, { email: "awa@acme.test", password: "a long password 42" });
    await requestPasswordReset(k.s, { email: "awa@acme.test" });
    const token = resetLinkFor("awa@acme.test");

    await resetPassword(k.s, { token, password: NEW_PASSWORD });

    expect(await userForSession(k.s, before.token)).toBeNull();
    await expectCode(signIn(k.s, { email: "awa@acme.test", password: "a long password 42" }), "invalid_credentials");
    expect((await signIn(k.s, { email: "awa@acme.test", password: NEW_PASSWORD })).user.email).toBe("awa@acme.test");
    expect(k.mailer.last("awa@acme.test")?.subject).toMatch(/modifié/);
    expect(await resetLinkValid(k.s, token)).toBe(false);
    await expectCode(resetPassword(k.s, { token, password: "yet another passphrase" }), "reset_link_invalid");
  });

  it("spends the link once when it is submitted twice at once", async () => {
    await owner();
    await requestPasswordReset(k.s, { email: "awa@acme.test" });
    const token = resetLinkFor("awa@acme.test");
    await k.warm();
    const results = await Promise.allSettled([
      resetPassword(k.s, { token, password: NEW_PASSWORD }),
      resetPassword(k.s, { token, password: "the other passphrase 8" }),
    ]);
    expect(failures(results)).toEqual(["reset_link_invalid"]);
    expect(k.mailer.to("awa@acme.test").filter((m) => /modifié/.test(m.subject))).toHaveLength(1);
  });

  it("keeps the link when the new password is too short", async () => {
    await owner();
    await requestPasswordReset(k.s, { email: "awa@acme.test" });
    const token = resetLinkFor("awa@acme.test");
    await expect(resetPassword(k.s, { token, password: "short" })).rejects.toSatisfy(
      (e) => isDomainError(e, "validation") && (e.details?.fields as Record<string, string>).password === "too_small",
    );
    expect(await resetLinkValid(k.s, token)).toBe(true);
  });

  it("expires after one hour and is replaced by a newer request", async () => {
    await owner();
    await requestPasswordReset(k.s, { email: "awa@acme.test" });
    const first = resetLinkFor("awa@acme.test");
    await requestPasswordReset(k.s, { email: "awa@acme.test" });
    const second = resetLinkFor("awa@acme.test");
    expect(await resetLinkValid(k.s, first)).toBe(false);
    expect(await resetLinkValid(k.s, second)).toBe(true);

    k.advance(RESET_TTL_MS + 1);
    expect(await resetLinkValid(k.s, second)).toBe(false);
    await expectCode(resetPassword(k.s, { token: second, password: NEW_PASSWORD }), "reset_link_invalid");
  });

  it("refuses unknown links", async () => {
    expect(await resetLinkValid(k.s, "nope")).toBe(false);
    await expectCode(resetPassword(k.s, { token: "x".repeat(43), password: NEW_PASSWORD }), "reset_link_invalid");
  });

  it("limits requests per address and per IP address", async () => {
    await owner();
    for (let i = 0; i < 3; i++) await requestPasswordReset(k.s, { email: "awa@acme.test" });
    await expectCode(requestPasswordReset(k.s, { email: "awa@acme.test" }), "rate_limited");
    expect(k.mailer.to("awa@acme.test").filter((m) => /reset/.test(m.text))).toHaveLength(3);

    const strict = await makeTestServices({ SIGNIN_IP_LIMIT: "2" });
    try {
      await requestPasswordReset(strict.s, { email: "a@x.test" }, { ip: "198.51.100.7" });
      await requestPasswordReset(strict.s, { email: "b@x.test" }, { ip: "198.51.100.7" });
      await expectCode(requestPasswordReset(strict.s, { email: "c@x.test" }, { ip: "198.51.100.7" }), "rate_limited");
      await requestPasswordReset(strict.s, { email: "c@x.test" }, { ip: "198.51.100.8" });
    } finally {
      await strict.cleanup();
    }
  });
});

describe("drafting an envelope", () => {
  it("cannot be sent until it has a document, an actor and a field per signer", async () => {
    const u = await owner();
    const env = await createEnvelope(k.s, u.id, { title: "Bail" });
    await expect(sendEnvelope(k.s, u.id, env.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "invalid_state") && JSON.stringify(e.details).includes("no_document"),
    );
    await attachDocument(k.s, u.id, env.id, { name: "bail.pdf", bytes: await samplePdf() });
    const signer = await addRecipient(k.s, u.id, env.id, { name: "Moussa", email: "moussa@example.test", role: "signer" });
    await expect(sendEnvelope(k.s, u.id, env.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "invalid_state") && (e.details?.recipients as string[]).includes(signer.id),
    );
  });

  it("is not sent under a placeholder title when the caller names them", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await updateEnvelope(k.s, u.id, env.id, { title: "Nouvelle demande" });
    const placeholderTitles = ["Nouvelle demande", "New request"];
    await expect(sendEnvelope(k.s, u.id, env.id, {}, { placeholderTitles })).rejects.toSatisfy(
      (e) => isDomainError(e, "invalid_state") && JSON.stringify(e.details?.problems) === JSON.stringify(["placeholder_title"]),
    );
    expect((await getEnvelope(k.s, u.id, env.id)).status).toBe("draft");
    expect(k.mailer.last("moussa@example.test")).toBeUndefined();
    await updateEnvelope(k.s, u.id, env.id, { title: "Bail Mermoz" });
    expect((await sendEnvelope(k.s, u.id, env.id, {}, { placeholderTitles })).status).toBe("in_progress");
  });

  it("records a change of title or message, and nothing when they are saved unchanged", async () => {
    const u = await owner();
    const env = await createEnvelope(k.s, u.id, { title: "Bail", message: "Merci." });
    const updates = async () => (await listEvents(k.s.db, env.id)).filter((e) => e.type === "envelope.updated").length;
    const before = await getEnvelope(k.s, u.id, env.id);
    k.advance(60_000);
    await updateEnvelope(k.s, u.id, env.id, { title: "  Bail ", message: "Merci." });
    expect(await updates()).toBe(0);
    expect((await getEnvelope(k.s, u.id, env.id)).updatedAt).toBe(before.updatedAt);
    await updateEnvelope(k.s, u.id, env.id, { title: "Bail Mermoz", message: "Merci." });
    await updateEnvelope(k.s, u.id, env.id, { title: "Bail Mermoz", message: "" });
    expect(await updates()).toBe(2);
    expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ title: "Bail Mermoz", message: null });
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("is invisible to other accounts", async () => {
    const { env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    const other = await owner("intruder@acme.test", "Intruder");
    await expectCode(getEnvelope(k.s, other.id, env.id), "not_found");
    await expectCode(sendEnvelope(k.s, other.id, env.id), "not_found");
    await expectCode(deleteEnvelope(k.s, other.id, env.id), "not_found");
    expect((await listEnvelopes(k.s, other.id)).total).toBe(0);
  });

  it("validates fields: signers only, inside the page and the document", async () => {
    const { u, env, recipients } = await readyEnvelope([
      { name: "Moussa", email: "moussa@example.test" },
      { name: "Fatou", email: "fatou@example.test", role: "approver" },
    ]);
    const [signer, approver] = recipients;
    const field = { recipientId: signer.id, page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.08 };
    await expectCode(setFields(k.s, u.id, env.id, [{ ...field, recipientId: approver.id }]), "validation");
    await expectCode(setFields(k.s, u.id, env.id, [{ ...field, page: 3 }]), "validation");
    await expectCode(setFields(k.s, u.id, env.id, [{ ...field, x: 0.9 }]), "validation");
  });

  it("stores field positions exactly as they were placed", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    const placed = { recipientId: recipients[0].id, page: 2, x: 0.1, y: 1 / 3, width: 0.123456789012, height: 0.08 };
    const saved = await setFields(k.s, u.id, env.id, [placed]);
    expect(saved.fields).toHaveLength(1);
    expect(saved.fields[0]).toMatchObject(placed);
    expect((await setFields(k.s, u.id, env.id, [])).fields).toHaveLength(0);
  });

  it("refuses duplicate recipients and clears fields when the document changes", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await expectCode(addRecipient(k.s, u.id, env.id, { name: "M", email: "MOUSSA@example.test", role: "viewer" }), "validation");
    expect((await getEnvelope(k.s, u.id, env.id)).fields).toHaveLength(1);
    await attachDocument(k.s, u.id, env.id, { name: "v2.pdf", bytes: await samplePdf({ pages: 3 }) });
    const updated = await getEnvelope(k.s, u.id, env.id);
    expect(updated).toMatchObject({ pageCount: 3, documentName: "v2.pdf" });
    expect(updated.fields).toHaveLength(0);
  });

  it("adds a recipient once when the same form is submitted twice at once", async () => {
    const u = await owner();
    const env = await createEnvelope(k.s, u.id, { title: "Bail" });
    const add = () => addRecipient(k.s, u.id, env.id, { name: "Moussa", email: "moussa@example.test", role: "signer" });
    await k.warm();
    const results = await Promise.allSettled([add(), add(), add()]);
    expect(failures(results)).toEqual(["validation", "validation"]);
    expect((await getEnvelope(k.s, u.id, env.id)).recipients.map((r) => r.position)).toEqual([1]);
  });

  it("is frozen once sent", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    await expectCode(updateEnvelope(k.s, u.id, env.id, { title: "Autre titre" }), "invalid_state");
    await expectCode(addRecipient(k.s, u.id, env.id, { name: "X", email: "x@example.test", role: "viewer" }), "invalid_state");
    await expectCode(removeRecipient(k.s, u.id, env.id, recipients[0].id), "invalid_state");
    await expectCode(attachDocument(k.s, u.id, env.id, { name: "other.pdf", bytes: await samplePdf() }), "invalid_state");
    await expectCode(deleteEnvelope(k.s, u.id, env.id), "invalid_state");
  });

  it("is sent once, and not edited afterwards, when sending races with itself and with an edit", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await k.warm();
    const results = await Promise.allSettled([
      sendEnvelope(k.s, u.id, env.id),
      sendEnvelope(k.s, u.id, env.id),
      removeRecipient(k.s, u.id, env.id, recipients[0].id),
    ]);
    const sent = (await getEnvelope(k.s, u.id, env.id)).status === "in_progress";
    if (sent) {
      // The removal lost the race: it found a sent envelope, and one invitation left.
      expect(failures(results).sort()).toEqual(["invalid_state", "invalid_state"]);
      expect(k.mailer.to("moussa@example.test")).toHaveLength(1);
      expect((await getEnvelope(k.s, u.id, env.id)).recipients).toHaveLength(1);
    } else {
      // The removal won: nothing was left to send.
      expect(failures(results)).toEqual(["invalid_state", "invalid_state"]);
      expect(k.mailer.to("moussa@example.test")).toHaveLength(0);
    }
    expect((await listEvents(k.s.db, env.id)).filter((e) => e.type === "envelope.sent")).toHaveLength(sent ? 1 : 0);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("keeps the history of a deleted draft", async () => {
    const u = await owner();
    const env = await createEnvelope(k.s, u.id, { title: "Brouillon" });
    await deleteEnvelope(k.s, u.id, env.id);
    expect((await listEnvelopes(k.s, u.id)).total).toBe(0);
    expect((await listEvents(k.s.db, env.id)).map((e) => e.type)).toEqual(["envelope.created", "envelope.deleted"]);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("lists, filters, searches and paginates", async () => {
    const u = await owner();
    for (let i = 1; i <= 25; i++) {
      k.advance(1000);
      const env = await createEnvelope(k.s, u.id, { title: `Facture ${i}` });
      if (i === 7) await addRecipient(k.s, u.id, env.id, { name: "Ibrahima Fall", email: "ibrahima@example.test", role: "signer" });
    }
    const first = await listEnvelopes(k.s, u.id, { pageSize: 10 });
    expect(first).toMatchObject({ total: 25, pages: 3 });
    expect(first.items[0].title).toBe("Facture 25");
    expect((await listEnvelopes(k.s, u.id, { page: 3, pageSize: 10 })).items).toHaveLength(5);
    expect((await listEnvelopes(k.s, u.id, { query: "ibrahima" })).items.map((i) => i.title)).toEqual(["Facture 7"]);
    expect((await listEnvelopes(k.s, u.id, { query: "Facture 1" })).total).toBe(11);
    expect((await listEnvelopes(k.s, u.id, { query: "facture 1" })).total).toBe(11);
    expect((await listEnvelopes(k.s, u.id, { query: "%" })).total).toBe(25);
    expect((await listEnvelopes(k.s, u.id, { query: "_\\" })).total).toBe(25);
    expect((await listEnvelopes(k.s, u.id, { query: "Facture\\" })).total).toBe(25);
    expect((await listEnvelopes(k.s, u.id, { status: "completed" })).total).toBe(0);
  });
});

describe("routing", () => {
  it("invites only the first routing order, then the next", async () => {
    const { u, env } = await readyEnvelope([
      { name: "Moussa", email: "moussa@example.test", routingOrder: 1 },
      { name: "Fatou", email: "fatou@example.test", routingOrder: 2 },
    ]);
    await sendEnvelope(k.s, u.id, env.id);
    expect(k.mailer.to("moussa@example.test")).toHaveLength(1);
    expect(k.mailer.to("fatou@example.test")).toHaveLength(0);
    expect(k.mailer.last("moussa@example.test").subject).toContain("Awa Ndiaye vous envoie « Contrat de prestation » à signer");

    await signAs("moussa@example.test");
    expect(k.mailer.to("fatou@example.test")).toHaveLength(1);
    expect((await getEnvelope(k.s, u.id, env.id)).status).toBe("in_progress");
  });

  it("invites recipients of the same order in parallel", async () => {
    const { u, env } = await readyEnvelope([
      { name: "Moussa", email: "moussa@example.test" },
      { name: "Fatou", email: "fatou@example.test" },
    ]);
    await sendEnvelope(k.s, u.id, env.id);
    expect(k.mailer.to("moussa@example.test")).toHaveLength(1);
    expect(k.mailer.to("fatou@example.test")).toHaveLength(1);
  });

  it("records the first opening only once", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    const view = await openCeremony(k.s, token, { ip: "198.51.100.1" });
    expect(view).toMatchObject({ canAct: true, recipient: { status: "viewed" }, envelope: { senderName: "Awa Ndiaye" } });
    expect(view.fields).toHaveLength(1);
    await openCeremony(k.s, token);
    expect((await listEvents(k.s.db, env.id)).filter((e) => e.type === "recipient.viewed")).toHaveLength(1);
  });

  it("records the first opening only once when the link is opened several times at once", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    await k.warm();
    const views = await Promise.all(Array.from({ length: 6 }, () => openCeremony(k.s, token)));
    expect(views.map((v) => v.recipient.status)).toEqual(Array(6).fill("viewed"));
    expect((await listEvents(k.s.db, env.id)).filter((e) => e.type === "recipient.viewed")).toHaveLength(1);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("rejects unknown links", async () => {
    await expectCode(openCeremony(k.s, "x".repeat(43)), "not_found");
  });
});

describe("one-time codes", () => {
  let token: string;
  let envelopeId: string;
  beforeEach(async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    token = linkFor("moussa@example.test");
    envelopeId = env.id;
  });

  it("are 6 digits, mailed, and never written to the audit trail", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    expect(code).toMatch(/^\d{6}$/);
    const trail = JSON.stringify(await listEvents(k.s.db, (await openCeremony(k.s, token)).envelope.id));
    expect(trail).not.toContain(code);
  });

  it("count wrong attempts, lock after five, and survive the failed request", async () => {
    await requestCode(k.s, token);
    const good = codeFor("moussa@example.test");
    const wrong = good === "000000" ? "111111" : "000000";
    const sig = await signature();
    for (let i = 0; i < 4; i++) await expectCode(act(k.s, token, { code: wrong, consent: true, signature: sig }), "otp_invalid");
    await expectCode(act(k.s, token, { code: wrong, consent: true, signature: sig }), "otp_locked");
    await expectCode(act(k.s, token, { code: good, consent: true, signature: sig }), "otp_locked");
  });

  it("count every wrong attempt when guesses arrive at once: five are examined, the rest find the code locked", async () => {
    await requestCode(k.s, token);
    const good = codeFor("moussa@example.test");
    const sig = await signature();
    const guesses = Array.from({ length: 30 }, (_, i) => String(100000 + i)).filter((g) => g !== good);
    await k.warm();
    const results = await Promise.allSettled(guesses.map((code) => act(k.s, token, { code, consent: true, signature: sig })));
    const codes = failures(results);
    expect(codes).toHaveLength(guesses.length);
    expect(codes.filter((c) => c === "otp_invalid")).toHaveLength(OTP_MAX_ATTEMPTS - 1);
    expect(codes.filter((c) => c === "otp_locked")).toHaveLength(guesses.length - (OTP_MAX_ATTEMPTS - 1));
    const failed = (await listEvents(k.s.db, envelopeId)).filter((e) => e.type === "otp.failed");
    expect(failed.map((e) => e.payload.attempts)).toEqual([1, 2, 3, 4, 5]);
    await expectCode(act(k.s, token, { code: good, consent: true, signature: sig }), "otp_locked");
    expect((await verifyChain(k.s.db, envelopeId)).ok).toBe(true);
  });

  it("sign once when the same valid code is submitted twice at once", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    const sig = await signature();
    await k.warm();
    const results = await Promise.allSettled([
      act(k.s, token, { code, consent: true, signature: sig }),
      act(k.s, token, { code, consent: true, signature: sig }),
      act(k.s, token, { code, consent: true, signature: sig }),
    ]);
    expect(failures(results)).toEqual(["invalid_state", "invalid_state"]);
    const types = (await listEvents(k.s.db, envelopeId)).map((e) => e.type);
    expect(types.filter((t) => t === "recipient.signed")).toHaveLength(1);
    expect(types.filter((t) => t === "envelope.completed")).toHaveLength(1);
    expect(types.filter((t) => t === "envelope.sealed")).toHaveLength(1);
    expect(k.mailer.to("moussa@example.test").filter((m) => /Terminé/.test(m.subject))).toHaveLength(1);
    expect((await verifyChain(k.s.db, envelopeId)).ok).toBe(true);
  });

  it("expire after ten minutes", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    k.advance(OTP_TTL_MS);
    await expectCode(act(k.s, token, { code, consent: true, signature: await signature() }), "otp_expired");
  });

  it("are replaced by a new request", async () => {
    await requestCode(k.s, token);
    const old = codeFor("moussa@example.test");
    await requestCode(k.s, token);
    const fresh = codeFor("moussa@example.test");
    if (old !== fresh) await expectCode(act(k.s, token, { code: old, consent: true, signature: await signature() }), "otp_invalid");
    await act(k.s, token, { code: fresh, consent: true, signature: await signature() });
  });

  it("are limited to five per hour", async () => {
    for (let i = 0; i < 5; i++) await requestCode(k.s, token);
    await expectCode(requestCode(k.s, token), "rate_limited");
    k.advance(3600_000);
    await requestCode(k.s, token);
  });

  it("are limited to five per hour even when requested at once, and only the last one is valid", async () => {
    await k.warm();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => requestCode(k.s, token)));
    expect(failures(results)).toEqual(Array(7).fill("rate_limited"));
    expect(k.mailer.to("moussa@example.test").filter((m) => /code/i.test(m.subject))).toHaveLength(5);
    const { rows } = await k.s.pool.query("select count(*)::int as n from otp_codes where consumed_at is null and invalidated_at is null");
    expect(rows[0].n).toBe(1);
  });

  it("are not burned by a missing consent or signature", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    await expectCode(act(k.s, token, { code, consent: false, signature: await signature() }), "consent_required");
    await expectCode(act(k.s, token, { code, consent: true }), "signature_required");
    await expectCode(act(k.s, token, { code, consent: true, signature: { kind: "drawn", png: Buffer.from("not a png") } }), "signature_required");
    await act(k.s, token, { code, consent: true, signature: await signature() });
    expect((await openCeremony(k.s, token)).recipient.status).toBe("signed");
  });

  it("cannot be reused once the recipient has acted", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    await act(k.s, token, { code, consent: true, signature: await signature() });
    await expectCode(requestCode(k.s, token), "invalid_state");
    await expectCode(act(k.s, token, { code, consent: true, signature: await signature() }), "invalid_state");
  });
});

describe("declining and cancelling", () => {
  it("closes the envelope, tells the sender why and the others only that it is closed", async () => {
    const { u, env } = await readyEnvelope([
      { name: "Moussa", email: "moussa@example.test" },
      { name: "Fatou", email: "fatou@example.test" },
    ]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    const fatou = linkFor("fatou@example.test");
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    await expectCode(decline(k.s, token, { code, reason: "  " }), "validation");
    await expectCode(decline(k.s, token, { code, reason: "x".repeat(501) }), "validation");
    await decline(k.s, token, { code, reason: "Le montant est erroné." });

    expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "declined" });
    expect(k.mailer.last("awa@acme.test").text).toContain("Le montant est erroné.");
    expect(k.mailer.last("fatou@example.test").subject).toContain("Refusé");
    expect(k.mailer.last("fatou@example.test").text).not.toContain("Le montant est erroné.");
    expect((await openCeremony(k.s, fatou)).canAct).toBe(false);
    await expectCode(requestCode(k.s, fatou), "invalid_state");
  });

  it("lets the owner cancel and stops everyone", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    await cancelEnvelope(k.s, u.id, env.id);
    expect(k.mailer.last("moussa@example.test").subject).toContain("Annulé");
    await expectCode(requestCode(k.s, token), "invalid_state");
    await expectCode(cancelEnvelope(k.s, u.id, env.id), "invalid_state");
  });

  it("ends either completed or cancelled, never both, when a signature races with the owner's cancellation", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    const sig = await signature();
    await k.warm();
    const [signing, cancelling] = await Promise.allSettled([
      act(k.s, token, { code, consent: true, signature: sig }),
      cancelEnvelope(k.s, u.id, env.id),
    ]);
    const final = await getEnvelope(k.s, u.id, env.id);
    const types = (await listEvents(k.s.db, env.id)).map((e) => e.type);
    if (final.status === "cancelled") {
      // The cancellation came first: the signature that followed was refused,
      // nothing is sealed, nothing is sent as final.
      expect(cancelling.status).toBe("fulfilled");
      expect(failures([signing])).toEqual(["invalid_state"]);
      expect(types).not.toContain("recipient.signed");
      expect(final.finalSha256).toBeNull();
      expect(types).not.toContain("envelope.completed");
      expect(types).not.toContain("envelope.sealed");
      expect(k.mailer.to("awa@acme.test").filter((m) => /Terminé/.test(m.subject))).toHaveLength(0);
    } else {
      expect(final.status).toBe("completed");
      expect(signing.status).toBe("fulfilled");
      expect(failures([cancelling])).toEqual(["invalid_state"]);
      expect(types).not.toContain("envelope.cancelled");
    }
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("refuses to cancel once everyone has signed, and resumes a seal that failed", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    const sig = await signature();
    const sealIdentity = k.s.sealIdentity;
    try {
      // The seal fails right after the last signature: signed by everyone, still in progress.
      k.s.sealIdentity = () => {
        throw new Error("seal unavailable");
      };
      await expect(act(k.s, token, { code, consent: true, signature: sig })).rejects.toThrow("seal unavailable");
      expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "in_progress" });

      // The sender can no longer withdraw it, even while the seal keeps failing.
      await expectCode(cancelEnvelope(k.s, u.id, env.id), "invalid_state");
      expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "in_progress", finalSha256: null });
    } finally {
      k.s.sealIdentity = sealIdentity;
    }

    // Seal available again: the refused cancellation is what resumes it.
    await expectCode(cancelEnvelope(k.s, u.id, env.id), "invalid_state");
    const final = await getEnvelope(k.s, u.id, env.id);
    expect(final.status).toBe("completed");
    expect(final.finalSha256).not.toBeNull();
    const types = (await listEvents(k.s.db, env.id)).map((e) => e.type);
    expect(types).toContain("recipient.signed");
    expect(types).toContain("envelope.sealed");
    expect(types).not.toContain("envelope.cancelled");
    expect(k.mailer.to("moussa@example.test").filter((m) => /Annulé/.test(m.subject))).toHaveLength(0);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("completes a request whose document was saved by incremental updates", async () => {
    // Two catalogs under one object number, the second with generation 1.
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }], catalogRedefinedAtGeneration1());
    await sendEnvelope(k.s, u.id, env.id);
    await signAs("moussa@example.test");
    const final = await getEnvelope(k.s, u.id, env.id);
    expect(final.status).toBe("completed");
    const sealed = k.s.files.get(final.finalSha256!);
    expect(checkPdfStructure(sealed)).toEqual([]);
    expect(verifySeal(sealed)).toMatchObject({ valid: true });
    expect(k.mailer.to("moussa@example.test").filter((m) => /Terminé/.test(m.subject))).toHaveLength(1);
  });

  it("neither seals nor sends a final PDF whose structure is invalid, and leaves the request in progress", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const token = linkFor("moussa@example.test");
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    const sig = await signature();
    // The PDF library writes a cross-reference table with one wrong row.
    const save = PDFDocument.prototype.save;
    const broken = vi.spyOn(PDFDocument.prototype, "save").mockImplementation(async function (this: PDFDocument, options) {
      return withOneWrongOffset(await save.call(this, options));
    });
    try {
      // The signature is recorded, then completion fails: signed by everyone, still in progress.
      await expect(act(k.s, token, { code, consent: true, signature: sig })).rejects.toBeInstanceOf(PdfStructureError);
      expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "in_progress", finalSha256: null });
      const types = (await listEvents(k.s.db, env.id)).map((e) => e.type);
      expect(types).toContain("recipient.signed");
      expect(types).not.toContain("envelope.completed");
      expect(types).not.toContain("envelope.sealed");
      expect(k.mailer.messages.filter((m) => /Terminé/.test(m.subject))).toHaveLength(0);

      // Trying again gives the same refusal: the sender's cancellation is refused and nothing is sealed.
      await expectCode(cancelEnvelope(k.s, u.id, env.id), "invalid_state");
      expect(await getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "in_progress", finalSha256: null });
    } finally {
      broken.mockRestore();
    }

    // Once the file can be written correctly, the next attempt seals it.
    await expectCode(cancelEnvelope(k.s, u.id, env.id), "invalid_state");
    const final = await getEnvelope(k.s, u.id, env.id);
    expect(final.status).toBe("completed");
    expect(checkPdfStructure(k.s.files.get(final.finalSha256!))).toEqual([]);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
  });

  it("issues a fresh link on resend and disables the old one", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const old = linkFor("moussa@example.test");
    await resendInvitation(k.s, u.id, env.id, recipients[0].id);
    const fresh = linkFor("moussa@example.test");
    expect(fresh).not.toBe(old);
    await expectCode(openCeremony(k.s, old), "not_found");
    expect((await openCeremony(k.s, fresh)).canAct).toBe(true);
  });
});

describe("completion", () => {
  it("seals the document, closes the envelope and sends it to everyone", async () => {
    const { u, env } = await readyEnvelope([
      { name: "Moussa Sow", email: "moussa@example.test", routingOrder: 1 },
      { name: "Fatou Diop", email: "fatou@example.test", role: "approver", routingOrder: 2 },
      { name: "Comptabilité", email: "compta@example.test", role: "viewer" },
    ]);
    await sendEnvelope(k.s, u.id, env.id);
    expect(k.mailer.to("compta@example.test")).toHaveLength(0);
    await signAs("moussa@example.test");

    const fatou = linkFor("fatou@example.test");
    await requestCode(k.s, fatou);
    await act(k.s, fatou, { code: codeFor("fatou@example.test"), consent: true });

    const done = await getEnvelope(k.s, u.id, env.id);
    expect(done.status).toBe("completed");
    expect(done.finalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(done.recipients.find((r) => r.role === "viewer")?.status).toBe("notified");

    for (const to of ["awa@acme.test", "moussa@example.test", "fatou@example.test", "compta@example.test"]) {
      const mail = k.mailer.last(to);
      expect(mail.subject).toContain("Terminé");
      expect(mail.attachments?.[0]).toMatchObject({ filename: "contrat (signed).pdf", contentType: "application/pdf" });
    }
    const pdf = k.mailer.last("compta@example.test").attachments![0].content;
    expect(verifySeal(pdf)).toMatchObject({ valid: true, certificateFingerprint: k.s.sealIdentity().fingerprint });

    const types = (await listEvents(k.s.db, env.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["envelope.sent", "recipient.signed", "recipient.approved", "envelope.completed", "envelope.sealed"]));
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);

    const download = await ceremonyDocument(k.s, fatou);
    expect(download).toMatchObject({ final: true, fileName: "contrat (signed).pdf" });
    expect(download.bytes.equals(pdf)).toBe(true);
  });

  it("completes once when the last two signers act at the same moment", async () => {
    const { u, env } = await readyEnvelope([
      { name: "Moussa Sow", email: "moussa@example.test" },
      { name: "Fatou Diop", email: "fatou@example.test" },
    ]);
    await sendEnvelope(k.s, u.id, env.id);
    const moussa = linkFor("moussa@example.test");
    const fatou = linkFor("fatou@example.test");
    await requestCode(k.s, moussa);
    await requestCode(k.s, fatou);
    const sig = await signature();
    await k.warm();
    await Promise.all([
      act(k.s, moussa, { code: codeFor("moussa@example.test"), consent: true, signature: sig }),
      act(k.s, fatou, { code: codeFor("fatou@example.test"), consent: true, signature: sig }),
    ]);

    const done = await getEnvelope(k.s, u.id, env.id);
    expect(done.status).toBe("completed");
    expect(done.recipients.map((r) => r.status)).toEqual(["signed", "signed"]);
    const types = (await listEvents(k.s.db, env.id)).map((e) => e.type);
    expect(types.filter((t) => t === "recipient.signed")).toHaveLength(2);
    expect(types.filter((t) => t === "envelope.completed")).toHaveLength(1);
    expect(types.slice(-2)).toEqual(["envelope.completed", "envelope.sealed"]);
    expect((await verifyChain(k.s.db, env.id)).ok).toBe(true);
    expect(k.mailer.to("awa@acme.test").filter((m) => /Terminé/.test(m.subject))).toHaveLength(1);
  });

  it("is verifiable from the file alone, and only for the exact sealed bytes", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa Sow", email: "moussa.sow@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    await signAs("moussa.sow@example.test");
    const pdf = k.mailer.last("moussa.sow@example.test").attachments![0].content;

    const check = await verifyUpload(k.s, pdf);
    expect(check.sealedByThisInstance).toBe(true);
    expect(check.envelope).toMatchObject({ id: env.id, title: "Contrat de prestation" });
    expect(check.envelope?.participants[0].email).toBe("m••••••w@example.test");

    const original = await verifyUpload(k.s, await samplePdf());
    expect(original).toMatchObject({ envelope: null, sealedByThisInstance: false, seal: { valid: false } });

    const altered = Buffer.concat([pdf, Buffer.from("\n")]);
    expect(await verifyUpload(k.s, altered)).toMatchObject({ envelope: null, seal: { valid: false } });
  });

  it("exposes nothing publicly before completion", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    expect(await publicEnvelope(k.s, env.id)).toBeNull();
    expect(await publicEnvelope(k.s, "../etc")).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps the domain and the first and last letters", () => {
    expect(maskEmail("ab@x.test")).toBe("a•@x.test");
    expect(maskEmail("fatou@x.test")).toBe("f•••u@x.test");
  });
});
