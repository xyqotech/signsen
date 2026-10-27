import { randomBytes } from "node:crypto";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";

export const PASSWORD = "une phrase de passe e2e 2026";

/** Unique per call, so tests run in parallel without sharing accounts or inboxes. */
export function uniqueEmail(label: string): string {
  return `${label}.${Date.now().toString(36)}${randomBytes(3).toString("hex")}@e2e.test`;
}

export function person(firstName: string, lastName: string) {
  return { name: `${firstName} ${lastName}`, email: uniqueEmail(firstName.toLowerCase()) };
}

export async function samplePdf(opts: { pages?: number; title?: string; rotateSecond?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < (opts.pages ?? 2); i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(opts.title ?? "Contrat de prestation de services", { x: 56, y: 780, size: 18, font: bold });
    page.drawText(`Page ${i + 1}`, { x: 56, y: 756, size: 11, font });
    for (let l = 0; l < 18; l++) {
      page.drawText("Le prestataire s'engage à fournir les services décrits en annexe, dans les délais convenus.", {
        x: 56,
        y: 720 - l * 18,
        size: 10,
        font,
      });
    }
    if (i === 1 && opts.rotateSecond) page.setRotation(degrees(90));
  }
  return { name: "contrat-prestation.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}
