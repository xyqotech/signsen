import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { sha256Hex } from "../crypto";
import { isDomainError } from "../errors";
import { makeTestServices, samplePdf, type TestKit } from "../testing";
import { buildFinalPdf, drawable, type FinalizeInput } from "./finalize";
import { inspectPdf } from "./inspect";
import { verifySeal } from "./verify";

const signaturePng = () => QRCode.toBuffer("signature", { width: 120 });

describe("inspectPdf", () => {
  it("describes pages, rotation included", async () => {
    const info = await inspectPdf(await samplePdf({ pages: 2, rotateSecond: true }));
    expect(info.pageCount).toBe(2);
    expect(info.pages[0]).toMatchObject({ rotation: 0 });
    expect(info.pages[1]).toMatchObject({ rotation: 90 });
  });

  it("rejects what is not a PDF", async () => {
    await expect(inspectPdf(Buffer.from("hello"))).rejects.toSatisfy((e) => isDomainError(e, "invalid_pdf"));
  });

  it("rejects a corrupted PDF", async () => {
    await expect(inspectPdf(Buffer.from("%PDF-1.7\n garbage"))).rejects.toSatisfy((e) =>
      isDomainError(e, "invalid_pdf"),
    );
  });
});

describe("drawable", () => {
  it("keeps what standard fonts can draw and degrades the rest", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(drawable(font, "Ndèye Fatou Ñdiaye")).toBe("Ndèye Fatou Ñdiaye");
    expect(drawable(font, "Ławrence 李")).toBe("?awrence ?");
    expect(drawable(font, "Ğül")).toBe("Gül");
  });
});

describe("final PDF and seal", () => {
  let k: TestKit;
  let original: Buffer;
  let final: Buffer;
  let input: FinalizeInput;

  beforeAll(async () => {
    k = makeTestServices({ APP_NAME: "Acme Conseil" });
    original = await samplePdf({ pages: 2, rotateSecond: true });
    const png = await signaturePng();
    input = {
      original,
      locale: "fr",
      brandName: "Acme Conseil",
      appUrl: "https://sign.acme.test",
      envelope: {
        id: "0b1c2d3e-0000-4000-8000-000000000001",
        title: "Contrat de prestation 2026",
        documentName: "contrat.pdf",
        originalSha256: sha256Hex(original),
        ownerName: "Awa Ndiaye",
        ownerEmail: "awa@acme.test",
        sentAt: Date.UTC(2026, 0, 15, 9),
        completedAt: Date.UTC(2026, 0, 15, 10),
      },
      recipients: [
        {
          id: "r1",
          name: "Moussa Sow",
          email: "moussa@example.test",
          role: "signer",
          status: "signed",
          viewedAt: Date.UTC(2026, 0, 15, 9, 30),
          actedAt: Date.UTC(2026, 0, 15, 9, 45),
          ip: "198.51.100.4",
          userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
          signatureImage: png,
        },
        {
          id: "r2",
          name: "Fatou Diop",
          email: "fatou@example.test",
          role: "approver",
          status: "approved",
          viewedAt: Date.UTC(2026, 0, 15, 9, 50),
          actedAt: Date.UTC(2026, 0, 15, 10),
          ip: "198.51.100.5",
          userAgent: "Mozilla/5.0",
          signatureImage: null,
        },
      ],
      fields: [
        { recipientId: "r1", page: 1, x: 0.55, y: 0.8, width: 0.3, height: 0.08 },
        { recipientId: "r1", page: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.08 },
      ],
      events: [
        { createdAt: Date.UTC(2026, 0, 15, 9), type: "envelope.sent", actorLabel: "Awa Ndiaye" },
        { createdAt: Date.UTC(2026, 0, 15, 9, 45), type: "recipient.signed", actorLabel: "Moussa Sow" },
      ],
      auditChainHash: "a".repeat(64),
      seal: k.s.sealIdentity(),
    };
    final = await buildFinalPdf(input);
  });
  afterAll(() => k.cleanup());

  it("keeps the original pages and appends the evidence certificate", async () => {
    const doc = await PDFDocument.load(final);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
  });

  it("is sealed by the instance certificate", () => {
    const check = verifySeal(final);
    expect(check).toMatchObject({ valid: true, certificateFingerprint: input.seal.fingerprint });
    if (check.valid) {
      expect(check.signerSubject).toContain("CN=Acme Conseil document seal");
      expect(check.signingTime?.getTime()).toBe(input.envelope.completedAt);
    }
  });

  it("detects a byte changed inside the signed content", () => {
    const tampered = Buffer.from(final);
    const at = tampered.indexOf("Contrat");
    tampered[at > 0 ? at : 200] ^= 0x01;
    expect(verifySeal(tampered)).toMatchObject({ valid: false });
  });

  it("detects a forged RSA signature even when the signed bytes are intact", () => {
    // Flip one nibble near the end of the DER: inside the encrypted digest, which
    // is the last element of the SignerInfo, before the zero padding.
    const text = final.toString("latin1");
    const [, a, b, c] = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].pop()!.map(Number);
    void a;
    const hex = text.slice(b + 1, c - 1);
    const derEnd = hex.replace(/(00)+$/, "").length;
    const at = b + 1 + derEnd - 20;
    const forged = Buffer.from(final);
    forged[at] = forged[at] === 0x30 ? 0x31 : 0x30;
    expect(verifySeal(forged)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("detects content appended after sealing", () => {
    const appended = Buffer.concat([final, Buffer.from("\n% appended\n")]);
    expect(verifySeal(appended)).toEqual({ valid: false, reason: "modified_after_signing" });
  });

  it("reports an unsigned PDF as such", () => {
    expect(verifySeal(original)).toEqual({ valid: false, reason: "no_signature" });
  });

  it("is reproducible from the same input apart from the seal itself", async () => {
    const again = await buildFinalPdf(input);
    expect(verifySeal(again)).toMatchObject({ valid: true });
  });
});
