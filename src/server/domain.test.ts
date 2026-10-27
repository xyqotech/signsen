import { afterEach, beforeEach, describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { listEvents, verifyChain } from "./audit";
import { SESSION_TTL_MS, signIn, signOut, signUp, userForSession, type PublicUser } from "./auth";
import { act, ceremonyDocument, decline, openCeremony, OTP_TTL_MS, requestCode } from "./ceremony";
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
} from "./envelopes";
import { isDomainError, type ErrorCode } from "./errors";
import { verifySeal } from "./pdf/verify";
import { makeTestServices, samplePdf, type TestKit } from "./testing";
import { maskEmail, publicEnvelope, verifyUpload } from "./verification";

const fails = (code: ErrorCode) => (e: unknown) => isDomainError(e, code);

async function expectCode(p: Promise<unknown> | (() => unknown), code: ErrorCode) {
  if (typeof p === "function") {
    try {
      p();
    } catch (e) {
      expect(e).toSatisfy(fails(code));
      return;
    }
    throw new Error(`expected ${code}, nothing thrown`);
  }
  await expect(p).rejects.toSatisfy(fails(code));
}

let k: TestKit;
beforeEach(() => (k = makeTestServices({ APP_NAME: "Acme" })));
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

/** Owner + envelope with a 2-page document and the given recipients, signers with one field each. */
async function readyEnvelope(
  people: { name: string; email: string; role?: "signer" | "approver" | "viewer"; routingOrder?: number }[],
) {
  const u = await owner();
  const env = createEnvelope(k.s, u.id, { title: "Contrat de prestation", message: "Merci de signer avant vendredi." });
  await attachDocument(k.s, u.id, env.id, { name: "contrat.pdf", bytes: await samplePdf() });
  const recipients = people.map((p) => addRecipient(k.s, u.id, env.id, { role: "signer", ...p }));
  setFields(
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

  it("refuses short passwords and closed signups", async () => {
    await expectCode(signUp(k.s, { email: "a@b.test", name: "A", password: "short", locale: "fr" }), "validation");
    const closed = makeTestServices({ ALLOW_SIGNUP: "false" });
    try {
      await expectCode(signUp(closed.s, { email: "a@b.test", name: "A", password: "a long password 42", locale: "fr" }), "signup_disabled");
    } finally {
      closed.cleanup();
    }
  });

  it("signs in, resolves the session, expires it and signs out", async () => {
    await owner();
    const { token } = await signIn(k.s, { email: "AWA@acme.test", password: "a long password 42" });
    expect(userForSession(k.s, token)?.email).toBe("awa@acme.test");
    signOut(k.s, token);
    expect(userForSession(k.s, token)).toBeNull();

    const second = await signIn(k.s, { email: "awa@acme.test", password: "a long password 42" });
    k.advance(SESSION_TTL_MS + 1);
    expect(userForSession(k.s, second.token)).toBeNull();
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await owner();
    await expectCode(signIn(k.s, { email: "awa@acme.test", password: "wrong password!!" }), "invalid_credentials");
    await expectCode(signIn(k.s, { email: "nobody@acme.test", password: "a long password 42" }), "invalid_credentials");
  });

  it("throttles sign-ins per IP address across accounts", async () => {
    const strict = makeTestServices({ SIGNIN_IP_LIMIT: "2" });
    try {
      for (const e of ["a@x.test", "b@x.test"]) {
        await expectCode(signIn(strict.s, { email: e, password: "whatever password" }, { ip: "198.51.100.7" }), "invalid_credentials");
      }
      await expectCode(signIn(strict.s, { email: "c@x.test", password: "whatever password" }, { ip: "198.51.100.7" }), "rate_limited");
      await expectCode(signIn(strict.s, { email: "c@x.test", password: "whatever password" }, { ip: "198.51.100.8" }), "invalid_credentials");
    } finally {
      strict.cleanup();
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

describe("drafting an envelope", () => {
  it("cannot be sent until it has a document, an actor and a field per signer", async () => {
    const u = await owner();
    const env = createEnvelope(k.s, u.id, { title: "Bail" });
    await expect(sendEnvelope(k.s, u.id, env.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "invalid_state") && JSON.stringify(e.details).includes("no_document"),
    );
    await attachDocument(k.s, u.id, env.id, { name: "bail.pdf", bytes: await samplePdf() });
    const signer = addRecipient(k.s, u.id, env.id, { name: "Moussa", email: "moussa@example.test", role: "signer" });
    await expect(sendEnvelope(k.s, u.id, env.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "invalid_state") && (e.details?.recipients as string[]).includes(signer.id),
    );
  });

  it("is invisible to other accounts", async () => {
    const { env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    const other = await owner("intruder@acme.test", "Intruder");
    await expectCode(() => getEnvelope(k.s, other.id, env.id), "not_found");
    await expectCode(sendEnvelope(k.s, other.id, env.id), "not_found");
    await expectCode(() => deleteEnvelope(k.s, other.id, env.id), "not_found");
    expect(listEnvelopes(k.s, other.id).total).toBe(0);
  });

  it("validates fields: signers only, inside the page and the document", async () => {
    const { u, env, recipients } = await readyEnvelope([
      { name: "Moussa", email: "moussa@example.test" },
      { name: "Fatou", email: "fatou@example.test", role: "approver" },
    ]);
    const [signer, approver] = recipients;
    const field = { recipientId: signer.id, page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.08 };
    await expectCode(() => setFields(k.s, u.id, env.id, [{ ...field, recipientId: approver.id }]), "validation");
    await expectCode(() => setFields(k.s, u.id, env.id, [{ ...field, page: 3 }]), "validation");
    await expectCode(() => setFields(k.s, u.id, env.id, [{ ...field, x: 0.9 }]), "validation");
  });

  it("refuses duplicate recipients and clears fields when the document changes", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await expectCode(() => addRecipient(k.s, u.id, env.id, { name: "M", email: "MOUSSA@example.test", role: "viewer" }), "validation");
    expect(getEnvelope(k.s, u.id, env.id).fields).toHaveLength(1);
    await attachDocument(k.s, u.id, env.id, { name: "v2.pdf", bytes: await samplePdf({ pages: 3 }) });
    const updated = getEnvelope(k.s, u.id, env.id);
    expect(updated).toMatchObject({ pageCount: 3, documentName: "v2.pdf" });
    expect(updated.fields).toHaveLength(0);
  });

  it("is frozen once sent", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    await expectCode(() => addRecipient(k.s, u.id, env.id, { name: "X", email: "x@example.test", role: "viewer" }), "invalid_state");
    await expectCode(() => removeRecipient(k.s, u.id, env.id, recipients[0].id), "invalid_state");
    await expectCode(attachDocument(k.s, u.id, env.id, { name: "other.pdf", bytes: await samplePdf() }), "invalid_state");
    await expectCode(() => deleteEnvelope(k.s, u.id, env.id), "invalid_state");
  });

  it("keeps the history of a deleted draft", async () => {
    const u = await owner();
    const env = createEnvelope(k.s, u.id, { title: "Brouillon" });
    deleteEnvelope(k.s, u.id, env.id);
    expect(listEnvelopes(k.s, u.id).total).toBe(0);
    expect(listEvents(k.s.db, env.id).map((e) => e.type)).toEqual(["envelope.created", "envelope.deleted"]);
    expect(verifyChain(k.s.db, env.id).ok).toBe(true);
  });

  it("lists, filters, searches and paginates", async () => {
    const u = await owner();
    for (let i = 1; i <= 25; i++) {
      k.advance(1000);
      const env = createEnvelope(k.s, u.id, { title: `Facture ${i}` });
      if (i === 7) addRecipient(k.s, u.id, env.id, { name: "Ibrahima Fall", email: "ibrahima@example.test", role: "signer" });
    }
    const first = listEnvelopes(k.s, u.id, { pageSize: 10 });
    expect(first).toMatchObject({ total: 25, pages: 3 });
    expect(first.items[0].title).toBe("Facture 25");
    expect(listEnvelopes(k.s, u.id, { page: 3, pageSize: 10 }).items).toHaveLength(5);
    expect(listEnvelopes(k.s, u.id, { query: "ibrahima" }).items.map((i) => i.title)).toEqual(["Facture 7"]);
    expect(listEnvelopes(k.s, u.id, { query: "Facture 1" }).total).toBe(11);
    expect(listEnvelopes(k.s, u.id, { query: "%" }).total).toBe(25);
    expect(listEnvelopes(k.s, u.id, { status: "completed" }).total).toBe(0);
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
    expect(getEnvelope(k.s, u.id, env.id).status).toBe("in_progress");
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
    const view = openCeremony(k.s, token, { ip: "198.51.100.1" });
    expect(view).toMatchObject({ canAct: true, recipient: { status: "viewed" }, envelope: { senderName: "Awa Ndiaye" } });
    expect(view.fields).toHaveLength(1);
    openCeremony(k.s, token);
    expect(listEvents(k.s.db, env.id).filter((e) => e.type === "recipient.viewed")).toHaveLength(1);
  });

  it("rejects unknown links", () => {
    expect(() => openCeremony(k.s, "x".repeat(43))).toThrow();
  });
});

describe("one-time codes", () => {
  let token: string;
  beforeEach(async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    token = linkFor("moussa@example.test");
  });

  it("are 6 digits, mailed, and never written to the audit trail", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    expect(code).toMatch(/^\d{6}$/);
    const trail = JSON.stringify(listEvents(k.s.db, openCeremony(k.s, token).envelope.id));
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

  it("are not burned by a missing consent or signature", async () => {
    await requestCode(k.s, token);
    const code = codeFor("moussa@example.test");
    await expectCode(act(k.s, token, { code, consent: false, signature: await signature() }), "consent_required");
    await expectCode(act(k.s, token, { code, consent: true }), "signature_required");
    await expectCode(act(k.s, token, { code, consent: true, signature: { kind: "drawn", png: Buffer.from("not a png") } }), "signature_required");
    await act(k.s, token, { code, consent: true, signature: await signature() });
    expect(openCeremony(k.s, token).recipient.status).toBe("signed");
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

    expect(getEnvelope(k.s, u.id, env.id)).toMatchObject({ status: "declined" });
    expect(k.mailer.last("awa@acme.test").text).toContain("Le montant est erroné.");
    expect(k.mailer.last("fatou@example.test").subject).toContain("Refusé");
    expect(k.mailer.last("fatou@example.test").text).not.toContain("Le montant est erroné.");
    expect(openCeremony(k.s, fatou).canAct).toBe(false);
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

  it("issues a fresh link on resend and disables the old one", async () => {
    const { u, env, recipients } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    const old = linkFor("moussa@example.test");
    await resendInvitation(k.s, u.id, env.id, recipients[0].id);
    const fresh = linkFor("moussa@example.test");
    expect(fresh).not.toBe(old);
    expect(() => openCeremony(k.s, old)).toThrow();
    expect(openCeremony(k.s, fresh).canAct).toBe(true);
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

    const done = getEnvelope(k.s, u.id, env.id);
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

    const types = listEvents(k.s.db, env.id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["envelope.sent", "recipient.signed", "recipient.approved", "envelope.completed", "envelope.sealed"]));
    expect(verifyChain(k.s.db, env.id).ok).toBe(true);

    const download = ceremonyDocument(k.s, fatou);
    expect(download).toMatchObject({ final: true, fileName: "contrat (signed).pdf" });
    expect(download.bytes.equals(pdf)).toBe(true);
  });

  it("is verifiable from the file alone, and only for the exact sealed bytes", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa Sow", email: "moussa.sow@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    await signAs("moussa.sow@example.test");
    const pdf = k.mailer.last("moussa.sow@example.test").attachments![0].content;

    const check = verifyUpload(k.s, pdf);
    expect(check.sealedByThisInstance).toBe(true);
    expect(check.envelope).toMatchObject({ id: env.id, title: "Contrat de prestation" });
    expect(check.envelope?.participants[0].email).toBe("m••••••w@example.test");

    const original = verifyUpload(k.s, await samplePdf());
    expect(original).toMatchObject({ envelope: null, sealedByThisInstance: false, seal: { valid: false } });

    const altered = Buffer.concat([pdf, Buffer.from("\n")]);
    expect(verifyUpload(k.s, altered)).toMatchObject({ envelope: null, seal: { valid: false } });
  });

  it("exposes nothing publicly before completion", async () => {
    const { u, env } = await readyEnvelope([{ name: "Moussa", email: "moussa@example.test" }]);
    await sendEnvelope(k.s, u.id, env.id);
    expect(publicEnvelope(k.s, env.id)).toBeNull();
    expect(publicEnvelope(k.s, "../etc")).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps the domain and the first and last letters", () => {
    expect(maskEmail("ab@x.test")).toBe("a•@x.test");
    expect(maskEmail("fatou@x.test")).toBe("f•••u@x.test");
  });
});
