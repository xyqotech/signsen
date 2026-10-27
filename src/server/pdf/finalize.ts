import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SUBFILTER_ADOBE_PKCS7_DETACHED } from "@signpdf/utils";
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { Locale } from "../config";
import type { SealIdentity } from "./seal-identity";

export interface FinalRecipient {
  id: string;
  name: string;
  email: string;
  role: "signer" | "approver" | "viewer";
  status: string;
  viewedAt: number | null;
  actedAt: number | null;
  ip: string | null;
  userAgent: string | null;
  signatureImage: Buffer | null;
}

export interface FinalField {
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FinalEvent {
  createdAt: number;
  type: string;
  actorLabel: string;
}

export interface FinalizeInput {
  original: Buffer;
  locale: Locale;
  brandName: string;
  appUrl: string;
  envelope: {
    id: string;
    title: string;
    documentName: string;
    originalSha256: string;
    ownerName: string;
    ownerEmail: string;
    sentAt: number;
    completedAt: number;
  };
  recipients: FinalRecipient[];
  fields: FinalField[];
  events: FinalEvent[];
  /** Hash of the last audit event at completion time. */
  auditChainHash: string;
  seal: SealIdentity;
}

const T = {
  fr: {
    signedBy: "Signé électroniquement par",
    certificate: "Certificat de preuve",
    envelope: "Demande",
    document: "Document",
    originalHash: "Empreinte SHA-256 du document d'origine",
    sender: "Expéditeur",
    sent: "Envoyée le",
    completed: "Terminée le",
    participants: "Participants",
    role: { signer: "Signataire", approver: "Approbateur", viewer: "Destinataire en copie" },
    status: {
      signed: "a signé",
      approved: "a approuvé",
      notified: "notifié",
      waiting: "en attente",
      viewed: "a consulté",
      declined: "a refusé",
    } as Record<string, string>,
    verification: "Vérification d'identité : code à usage unique envoyé à l'adresse e-mail",
    viewedAt: "Consulté le",
    actedAt: "Action le",
    ip: "Adresse IP",
    device: "Appareil",
    consent:
      "Avant d'agir, chaque participant a coché la case « J'ai lu le document et je le signe électroniquement » (approbation pour les approbateurs).",
    history: "Historique",
    auditHash: "Empreinte finale du journal d'audit",
    seal: "Sceau de l'instance",
    fingerprint: "Empreinte du certificat",
    selfSigned: "certificat auto-signé de l'instance",
    level:
      "Niveau : signature électronique simple, appuyée par un dossier de preuve (identification par code à usage unique, consentement explicite, intégrité du document et journal d'audit chaîné). Il ne s'agit pas d'une signature électronique qualifiée.",
    verify: "Vérifier ce document",
    verifyHint: "Déposez ce PDF sur la page de vérification, ou scannez le code.",
    page: "Page",
    times: "Heures en UTC.",
    events: {
      "envelope.sent": "Demande envoyée",
      "recipient.notified": "Invitation envoyée",
      "recipient.viewed": "Document consulté",
      "recipient.signed": "Signature",
      "recipient.approved": "Approbation",
      "recipient.declined": "Refus",
      "document.attached": "Document joint",
      "envelope.created": "Demande créée",
    } as Record<string, string>,
  },
  en: {
    signedBy: "Electronically signed by",
    certificate: "Evidence certificate",
    envelope: "Request",
    document: "Document",
    originalHash: "SHA-256 of the original document",
    sender: "Sender",
    sent: "Sent on",
    completed: "Completed on",
    participants: "Participants",
    role: { signer: "Signer", approver: "Approver", viewer: "Copy recipient" },
    status: {
      signed: "signed",
      approved: "approved",
      notified: "notified",
      waiting: "waiting",
      viewed: "viewed",
      declined: "declined",
    } as Record<string, string>,
    verification: "Identity check: one-time code sent to the e-mail address",
    viewedAt: "Viewed on",
    actedAt: "Acted on",
    ip: "IP address",
    device: "Device",
    consent:
      'Before acting, every participant ticked "I have read the document and I sign it electronically" (approval for approvers).',
    history: "History",
    auditHash: "Final hash of the audit trail",
    seal: "Instance seal",
    fingerprint: "Certificate fingerprint",
    selfSigned: "self-signed certificate of this instance",
    level:
      "Level: simple electronic signature backed by an evidence file (one-time code identification, explicit consent, document integrity and hash-chained audit trail). This is not a qualified electronic signature.",
    verify: "Verify this document",
    verifyHint: "Drop this PDF on the verification page, or scan the code.",
    page: "Page",
    times: "Times in UTC.",
    events: {
      "envelope.sent": "Request sent",
      "recipient.notified": "Invitation sent",
      "recipient.viewed": "Document viewed",
      "recipient.signed": "Signature",
      "recipient.approved": "Approval",
      "recipient.declined": "Decline",
      "document.attached": "Document attached",
      "envelope.created": "Request created",
    } as Record<string, string>,
  },
};

export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Standard fonts only encode WinAnsi: replace what they cannot draw. */
export function drawable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      let ok = base.length > 0;
      try {
        if (ok) font.encodeText(base);
      } catch {
        ok = false;
      }
      out += ok ? base : "?";
    }
  }
  return out;
}

/**
 * Maps a point given in displayed-page coordinates (origin top-left, y down —
 * what the user saw when placing the field) to PDF user space, for pages with a
 * /Rotate of 0, 90, 180 or 270.
 */
function toPdfSpace(page: PDFPage, dx: number, dy: number) {
  const { width: W, height: H } = page.getSize();
  switch (((page.getRotation().angle % 360) + 360) % 360) {
    case 90:
      return { x: dy, y: dx };
    case 180:
      return { x: W - dx, y: dy };
    case 270:
      return { x: W - dy, y: H - dx };
    default:
      return { x: dx, y: H - dy };
  }
}

function displayedSize(page: PDFPage) {
  const { width, height } = page.getSize();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

async function stampSignatures(doc: PDFDocument, input: FinalizeInput, font: PDFFont) {
  const t = T[input.locale];
  const byId = new Map(input.recipients.map((r) => [r.id, r]));
  const images = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  for (const r of input.recipients) {
    if (r.signatureImage) images.set(r.id, await doc.embedPng(r.signatureImage));
  }
  const pages = doc.getPages();
  for (const f of input.fields) {
    const recipient = byId.get(f.recipientId);
    const image = images.get(f.recipientId);
    const page = pages[f.page - 1];
    if (!recipient || !image || !page) continue;
    const rotation = degrees(((page.getRotation().angle % 360) + 360) % 360);
    const size = displayedSize(page);
    const box = { x: f.x * size.width, y: f.y * size.height, w: f.width * size.width, h: f.height * size.height };

    const caption = Math.max(4.5, Math.min(7, box.h * 0.13));
    const captionArea = caption * 2.6;
    const imgArea = { w: box.w, h: Math.max(box.h - captionArea, box.h * 0.5) };
    const scale = Math.min(imgArea.w / image.width, imgArea.h / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    const imgLeft = box.x + (box.w - w) / 2;
    const imgBottom = box.y + (imgArea.h - h) / 2 + h; // displayed y of the image's bottom edge
    const anchor = toPdfSpace(page, imgLeft, imgBottom);
    page.drawImage(image, { x: anchor.x, y: anchor.y, width: w, height: h, rotate: rotation });

    const lines = [
      `${t.signedBy} ${recipient.name}`,
      recipient.actedAt ? formatUtc(recipient.actedAt) : "",
    ];
    lines.forEach((line, i) => {
      const text = drawable(font, line);
      const p = toPdfSpace(page, box.x + 1, box.y + imgArea.h + caption * (1.15 + i * 1.2));
      page.drawText(text, {
        x: p.x,
        y: p.y,
        size: caption,
        font,
        color: rgb(0.25, 0.25, 0.3),
        rotate: rotation,
        maxWidth: box.w,
      });
    });
  }
}

/** Simple top-down text layout over as many A4 pages as needed. */
class Writer {
  page!: PDFPage;
  y = 0;
  readonly margin = 48;
  readonly width = 595.28;
  readonly height = 841.89;
  pageNo = 0;

  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private footer: string,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.pageNo += 1;
    this.y = this.height - this.margin;
    this.page.drawText(drawable(this.regular, `${this.footer} — ${this.pageNo}`), {
      x: this.margin,
      y: 24,
      size: 7,
      font: this.regular,
      color: rgb(0.45, 0.45, 0.5),
    });
  }

  ensure(space: number) {
    if (this.y - space < this.margin) this.newPage();
  }

  text(content: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.bold : this.regular;
    const indent = opts.indent ?? 0;
    const maxWidth = this.width - 2 * this.margin - indent;
    for (const line of wrap(font, drawable(font, content), size, maxWidth)) {
      this.ensure(size * 1.4);
      this.page.drawText(line, {
        x: this.margin + indent,
        y: this.y - size,
        size,
        font,
        color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])),
      });
      this.y -= size * 1.4;
    }
  }

  gap(h = 8) {
    this.y -= h;
  }

  rule() {
    this.ensure(10);
    this.page.drawLine({
      start: { x: this.margin, y: this.y - 4 },
      end: { x: this.width - this.margin, y: this.y - 4 },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.82),
    });
    this.y -= 10;
  }
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      // Words longer than the line (hashes, user agents) are cut.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

async function appendCertificate(doc: PDFDocument, input: FinalizeInput) {
  const t = T[input.locale];
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const e = input.envelope;
  const w = new Writer(doc, regular, bold, `${input.brandName} · ${t.certificate} · ${e.id}`);

  w.text(input.brandName, { size: 10, bold: true, color: [0.12, 0.43, 0.36] });
  w.text(t.certificate, { size: 18, bold: true });
  w.gap(4);
  w.text(`${t.envelope} : ${e.title}`, { size: 11, bold: true });
  w.text(`${t.document} : ${e.documentName}`);
  w.text(`${t.originalHash} : ${e.originalSha256}`, { size: 8 });
  w.text(`${t.sender} : ${e.ownerName} <${e.ownerEmail}>`);
  w.text(`${t.sent} ${formatUtc(e.sentAt)} — ${t.completed} ${formatUtc(e.completedAt)}`);
  w.text(`ID : ${e.id}`, { size: 8, color: [0.4, 0.4, 0.45] });
  w.rule();

  w.text(t.participants, { size: 12, bold: true });
  for (const r of input.recipients) {
    w.ensure(70);
    w.gap(4);
    w.text(`${r.name} <${r.email}> — ${t.role[r.role]}, ${t.status[r.status] ?? r.status}`, { bold: true });
    if (r.role !== "viewer") {
      w.text(t.verification, { indent: 10, size: 8 });
      if (r.viewedAt) w.text(`${t.viewedAt} ${formatUtc(r.viewedAt)}`, { indent: 10, size: 8 });
      if (r.actedAt) w.text(`${t.actedAt} ${formatUtc(r.actedAt)}`, { indent: 10, size: 8 });
      if (r.ip) w.text(`${t.ip} : ${r.ip}`, { indent: 10, size: 8 });
      if (r.userAgent) w.text(`${t.device} : ${r.userAgent}`, { indent: 10, size: 7, color: [0.4, 0.4, 0.45] });
    }
  }
  w.gap(4);
  w.text(t.consent, { size: 8 });
  w.rule();

  w.text(t.history, { size: 12, bold: true });
  for (const ev of input.events) {
    w.text(`${formatUtc(ev.createdAt)}  ${t.events[ev.type] ?? ev.type} — ${ev.actorLabel}`, { size: 7.5 });
  }
  w.text(`${t.auditHash} : ${input.auditChainHash}`, { size: 7.5, bold: true });
  w.rule();

  const seal = input.seal;
  w.text(t.seal, { size: 12, bold: true });
  w.text(`${seal.subject}${seal.selfSigned ? ` (${t.selfSigned})` : ""}`, { size: 8 });
  w.text(`${t.fingerprint} (SHA-256) : ${seal.fingerprint}`, { size: 7.5 });
  w.gap(4);
  w.text(t.level, { size: 8, color: [0.3, 0.3, 0.35] });
  w.rule();

  const verifyUrl = `${input.appUrl}/verify/${e.id}`;
  w.ensure(110);
  const qr = await doc.embedPng(await QRCode.toBuffer(verifyUrl, { margin: 1, width: 240 }));
  const qrSize = 88;
  w.page.drawImage(qr, { x: w.margin, y: w.y - qrSize, width: qrSize, height: qrSize });
  const textTop = w.y;
  w.y = textTop - 6;
  w.text(t.verify, { size: 11, bold: true, indent: qrSize + 12 });
  w.text(verifyUrl, { size: 8, indent: qrSize + 12 });
  w.text(t.verifyHint, { size: 8, indent: qrSize + 12 });
  w.y = Math.min(w.y, textTop - qrSize - 8);
  w.text(t.times, { size: 7, color: [0.45, 0.45, 0.5] });
}

/** Produces the final PDF: stamped signatures + evidence certificate + instance seal. */
export async function buildFinalPdf(input: FinalizeInput): Promise<Buffer> {
  const doc = await PDFDocument.load(input.original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await stampSignatures(doc, input, font);
  await appendCertificate(doc, input);
  doc.setProducer(`${input.brandName} (SignSen)`);
  doc.setModificationDate(new Date(input.envelope.completedAt));

  const signingTime = new Date(input.envelope.completedAt);
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: `${T[input.locale].seal} — ${input.envelope.id}`,
    contactInfo: input.appUrl,
    name: input.seal.subject,
    location: new URL(input.appUrl).host,
    signingTime,
    signatureLength: 16384,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
    appName: input.brandName,
  });
  const unsigned = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new P12Signer(input.seal.p12, { passphrase: input.seal.password });
  return new SignPdf().sign(unsigned, signer, signingTime);
}
