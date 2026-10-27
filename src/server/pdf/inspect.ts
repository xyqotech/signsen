import { PDFDocument } from "pdf-lib";
import { DomainError } from "../errors";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;

export interface PdfInfo {
  pageCount: number;
  pages: { width: number; height: number; rotation: number }[];
}

/** Validates an uploaded PDF and describes its pages. */
export async function inspectPdf(bytes: Buffer): Promise<PdfInfo> {
  if (bytes.length > MAX_PDF_BYTES) throw new DomainError("pdf_too_large");
  if (bytes.subarray(0, 1024).indexOf("%PDF-") === -1) throw new DomainError("invalid_pdf");
  let pages: PdfInfo["pages"];
  try {
    // pdf-lib "loads" some broken files and only fails when the page tree is read,
    // so reading the pages belongs inside the guarded block.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    pages = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width, height, rotation: ((p.getRotation().angle % 360) + 360) % 360 };
    });
  } catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message)) throw new DomainError("pdf_encrypted");
    throw new DomainError("invalid_pdf");
  }
  if (pages.length === 0) throw new DomainError("invalid_pdf");
  if (pages.length > MAX_PDF_PAGES) throw new DomainError("pdf_too_large", "Too many pages");
  return { pageCount: pages.length, pages };
}
