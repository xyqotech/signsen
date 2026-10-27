import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { parseConfig } from "./config";
import { MemoryMailer } from "./mail";
import { createServices, type Services } from "./services";

/** Fresh, isolated services for one test: temporary data dir, in-memory mail, manual clock. */
export function makeTestServices(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signsen-test-"));
  const clock = { t: Date.UTC(2026, 0, 15, 9, 0, 0) };
  const mailer = new MemoryMailer();
  const config = parseConfig({
    DATA_DIR: dir,
    APP_URL: "http://signsen.test",
    MAIL_TRANSPORT: "console",
    ...env,
  });
  const s: Services = createServices(config, { mailer, now: () => clock.t });
  return {
    s,
    mailer,
    clock,
    advance(ms: number) {
      clock.t += ms;
    },
    cleanup() {
      s.sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestKit = ReturnType<typeof makeTestServices>;

/** A small synthetic A4 PDF; the second page can be rotated by 90°. */
export async function samplePdf(opts: { pages?: number; rotateSecond?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 2); i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Contrat de prestation — page ${i + 1}`, { x: 60, y: 780, size: 14, font });
    if (i === 1 && opts.rotateSecond) page.setRotation(degrees(90));
  }
  return Buffer.from(await doc.save());
}
