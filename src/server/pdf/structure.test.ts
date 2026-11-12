import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignPdf } from "@signpdf/signpdf";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import { sha256Hex } from "../crypto";
import { makeTestServices, samplePdf, type TestKit } from "../testing";
import { buildFinalPdf, type FinalizeInput } from "./finalize";
import { checkPdfStructure, PdfStructureError } from "./structure";
import {
  catalogRedefinedAtGeneration1,
  NUM,
  objectFreedNotReused,
  objectFreedThenReused,
  ORIGINAL_PAGE_COUNT,
  unlistedHigherGeneration,
  updatedWithoutGenerationChange,
  withOneWrongOffset,
} from "./testing";
import { verifySeal } from "./verify";

/**
 * Reads a PDF the way a strict reader does — `startxref`, the cross-reference
 * table, the trailer, then objects through the table only — and lists what
 * does not add up. Written for these tests, on purpose without the production
 * check and without the PDF library (which never reads the table).
 */
function readThroughXref(pdf: Buffer) {
  const text = pdf.toString("latin1");
  const problems: string[] = [];
  const startxref = /startxref\n(\d+)\n%%EOF\n?$/.exec(text);
  const lines = startxref ? text.slice(Number(startxref[1])).split("\n") : [];
  if (lines.shift() !== "xref") problems.push("startxref does not point at a cross-reference table");

  const listed: number[] = [];
  const inUse = new Map<number, { offset: number; gen: number }>();
  while (/^\d+ \d+$/.test(lines[0] ?? "")) {
    const [first, count] = lines.shift()!.split(" ").map(Number);
    for (let i = 0; i < count; i++) {
      const row = /^(\d{10}) (\d{5}) ([nf]) $/.exec(lines.shift() ?? "");
      if (!row) problems.push(`row of object ${first + i} is malformed`);
      listed.push(first + i);
      if (row?.[3] === "n") inUse.set(first + i, { offset: Number(row[1]), gen: Number(row[2]) });
    }
  }
  while (lines[0] === "") lines.shift();
  if (lines[0] !== "trailer") problems.push("the table is not followed by the trailer");
  const trailer = lines.join("\n");
  const size = Number(/\/Size (\d+)/.exec(trailer)?.[1]);
  const root = /\/Root (\d+) (\d+) R/.exec(trailer);

  if (new Set(listed).size !== listed.length) problems.push("an object number is listed twice");
  if (Math.max(...listed) + 1 !== size) problems.push(`/Size is ${size} but the table goes up to object ${Math.max(...listed)}`);
  for (const [num, { offset, gen }] of inUse) {
    const header = `${num} ${gen} obj\n`;
    if (text.slice(offset, offset + header.length) !== header) {
      problems.push(`row of object ${num} ${gen} points at "${text.slice(offset, offset + 16).split("\n")[0]}"`);
    }
  }

  /** What is between `obj` and `endobj`, for an object reached through the table. */
  const object = (num: number, gen: number): string | null => {
    const row = inUse.get(num);
    if (!row || row.gen !== gen) return null;
    const from = row.offset + `${num} ${gen} obj\n`.length;
    return text.slice(from, text.indexOf("\nendobj", from));
  };
  const catalog = root ? object(Number(root[1]), Number(root[2])) : null;
  if (!catalog || !/\/Type \/Catalog\b/.test(catalog)) problems.push("/Root does not resolve to the catalog");
  const pagesRef = /\/Pages (\d+) (\d+) R/.exec(catalog ?? "");
  const pageTree = pagesRef ? object(Number(pagesRef[1]), Number(pagesRef[2])) : null;
  return { problems, size, object, catalog, pageCount: Number(/\/Count (\d+)/.exec(pageTree ?? "")?.[1]) };
}

/** Headers (`N G obj`) of every object with this number, wherever it is in the file. */
function headersOf(pdf: Buffer, num: number): string[] {
  return [...pdf.toString("latin1").matchAll(new RegExp(`^${num} \\d+ obj$`, "gm"))].map((m) => m[0]);
}

/** What `buildFinalPdf` hands to the seal: a classic table, no object streams. */
async function savedWithTable(pdf: Buffer): Promise<Buffer> {
  return Buffer.from(await (await PDFDocument.load(pdf, { updateMetadata: false })).save({ useObjectStreams: false }));
}

let k: TestKit;
let signature: Buffer;
beforeAll(async () => {
  k = await makeTestServices({ APP_NAME: "Acme Conseil" });
  signature = await QRCode.toBuffer("signature", { width: 120 });
});
afterAll(() => k.cleanup());
afterEach(() => vi.restoreAllMocks());

/** One signer who signed on page 1. */
function inputFor(original: Buffer): FinalizeInput {
  return {
    original,
    locale: "fr",
    brandName: "Acme Conseil",
    appUrl: "https://sign.acme.test",
    envelope: {
      id: "0b1c2d3e-0000-4000-8000-000000000002",
      title: "Synthetic agreement",
      documentName: "agreement.pdf",
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
        userAgent: "Mozilla/5.0",
        signatureImage: signature,
      },
    ],
    fields: [{ recipientId: "r1", page: 1, x: 0.55, y: 0.8, width: 0.3, height: 0.08 }],
    events: [{ createdAt: Date.UTC(2026, 0, 15, 9), type: "envelope.sent", actorLabel: "Awa Ndiaye" }],
    auditChainHash: "a".repeat(64),
    seal: k.s.sealIdentity(),
  };
}

describe("final PDF of a document saved by incremental updates", () => {
  /** Pages the evidence certificate takes for `inputFor`, measured on a document without history. */
  let certificatePages: number;
  beforeAll(async () => {
    const plain = await buildFinalPdf(inputFor(await samplePdf({ pages: ORIGINAL_PAGE_COUNT })));
    certificatePages = (await PDFDocument.load(plain)).getPageCount() - ORIGINAL_PAGE_COUNT;
    expect(certificatePages).toBeGreaterThanOrEqual(1);
  });

  it("has an exact cross-reference table when an update redefined the catalog with generation 1", async () => {
    const original = catalogRedefinedAtGeneration1();
    // The fixture has the shape that used to break: both generations of the
    // catalog, a second section made of the subsection "17 1", a trailer chain.
    const source = original.toString("latin1");
    expect(NUM.catalog).toBe(17);
    expect(headersOf(original, 17)).toEqual(["17 0 obj", "17 1 obj"]);
    expect(source).toMatch(/xref\n17 1\n\d{10} 00001 n \ntrailer\n<< \/Size 19 \/Root 17 1 R \/Info 18 0 R \/Prev \d+ >>/);
    expect(source.match(/^xref$/gm)).toHaveLength(2);

    const final = await buildFinalPdf(inputFor(original));
    const read = readThroughXref(final);
    expect(read.problems).toEqual([]);
    // One catalog is left, the one in use, and the seal's form went into it.
    expect(headersOf(final, 17)).toEqual(["17 1 obj"]);
    expect(read.catalog).toContain("/Lang (fr-SN)");
    expect(read.catalog).toContain("/AcroForm");
    // Same pages for a reader that follows the table and for the PDF library.
    expect(read.pageCount).toBe(ORIGINAL_PAGE_COUNT + certificatePages);
    expect((await PDFDocument.load(final)).getPageCount()).toBe(ORIGINAL_PAGE_COUNT + certificatePages);
    // The signature is stamped on page 1, over its original content.
    const page1 = read.object(NUM.firstPage, 0);
    expect(page1).toContain(`${NUM.firstContent} 0 R`);
    expect(page1).toContain("/XObject");
    expect(verifySeal(final)).toMatchObject({ valid: true, certificateFingerprint: k.s.sealIdentity().fingerprint });
  });

  it("carries the object in use, not the freed one, when a number was freed then used again", async () => {
    const original = objectFreedThenReused();
    expect(headersOf(original, NUM.firstContent)).toEqual(["3 0 obj", "3 1 obj"]);

    const final = await buildFinalPdf(inputFor(original));
    const read = readThroughXref(final);
    expect(read.problems).toEqual([]);
    expect(headersOf(final, NUM.firstContent)).toEqual(["3 1 obj"]);
    expect(read.object(NUM.firstContent, 1)).toContain("page 1 as revised");
    expect(final.includes("Synthetic agreement - page 1)")).toBe(false);
    expect(read.object(NUM.firstPage, 0)).toContain(`${NUM.firstContent} 1 R`);
    expect(read.pageCount).toBe(ORIGINAL_PAGE_COUNT + certificatePages);
    expect(verifySeal(final)).toMatchObject({ valid: true });
  });

  it("follows an update that kept the generations: the added page is there", async () => {
    const final = await buildFinalPdf(inputFor(updatedWithoutGenerationChange()));
    const read = readThroughXref(final);
    expect(read.problems).toEqual([]);
    expect(read.pageCount).toBe(ORIGINAL_PAGE_COUNT + 1 + certificatePages);
    expect((await PDFDocument.load(final)).getPageCount()).toBe(ORIGINAL_PAGE_COUNT + 1 + certificatePages);
    expect(verifySeal(final)).toMatchObject({ valid: true });
  });

  it("keeps the catalog the trailer names when a stray object has a higher generation", async () => {
    const original = unlistedHigherGeneration();
    expect(headersOf(original, 17)).toEqual(["17 0 obj", "17 1 obj"]);
    expect(original.toString("latin1")).toMatch(/\/Root 17 0 R \/Info 18 0 R \/Prev \d+ >>\nstartxref\n\d+\n%%EOF\n$/);

    const final = await buildFinalPdf(inputFor(original));
    const read = readThroughXref(final);
    expect(read.problems).toEqual([]);
    expect(headersOf(final, 17)).toEqual(["17 0 obj"]);
    expect(read.catalog).not.toContain("stray");
    expect(read.catalog).toContain("/AcroForm");
    expect(read.pageCount).toBe(ORIGINAL_PAGE_COUNT + certificatePages);
    expect(verifySeal(final)).toMatchObject({ valid: true });
  });

  it("stays well formed when an update freed an object and nothing took its number", async () => {
    const final = await buildFinalPdf(inputFor(objectFreedNotReused()));
    const read = readThroughXref(final);
    expect(read.problems).toEqual([]);
    expect(read.pageCount).toBe(ORIGINAL_PAGE_COUNT + certificatePages);
    expect(verifySeal(final)).toMatchObject({ valid: true });
  });
});

describe("checkPdfStructure", () => {
  it("accepts what the finalisation writes, before and after the seal", async () => {
    const plain = await samplePdf({ pages: 2 });
    expect(checkPdfStructure(await savedWithTable(plain))).toEqual([]);
    expect(checkPdfStructure(await buildFinalPdf(inputFor(plain)))).toEqual([]);
  });

  it("reports the table the PDF library writes for two generations of one number", async () => {
    // Loaded and saved with nothing dropped: both catalogs get a row, and the
    // rows that follow are each one object late.
    const broken = await savedWithTable(catalogRedefinedAtGeneration1());
    expect(headersOf(broken, 17)).toEqual(["17 0 obj", "17 1 obj"]);
    expect(checkPdfStructure(broken)).toEqual([
      "/Size is 19 but the cross-reference table lists objects up to 19",
      "/Root 17 1 R is not an object in use",
      'cross-reference entry of object 18 1 points at "17 1 obj"',
      'cross-reference entry of object 19 0 points at "18 0 obj"',
    ]);
    // The independent reader agrees.
    expect(readThroughXref(broken).problems).not.toEqual([]);
  });

  it("reports an entry that points beside its object", async () => {
    const problems = checkPdfStructure(withOneWrongOffset(await savedWithTable(await samplePdf())));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^cross-reference entry of object 1 0 points at /);
  });

  it("reports an inconsistent /Size", async () => {
    const good = (await savedWithTable(await samplePdf())).toString("latin1");
    const size = Number(/\/Size (\d+)/.exec(good)![1]);
    const problems = checkPdfStructure(Buffer.from(good.replace(`/Size ${size}`, `/Size ${size + 1}`), "latin1"));
    expect(problems).toEqual([`/Size is ${size + 1} but the cross-reference table lists objects up to ${size - 1}`]);
  });

  it("reports a /Root that does not resolve to the catalog", async () => {
    const good = (await savedWithTable(await samplePdf())).toString("latin1");
    const [, num] = /\/Root (\d+) 0 R/.exec(good)!;
    const otherGeneration = Buffer.from(good.replace(`/Root ${num} 0 R`, `/Root ${num} 1 R`), "latin1");
    expect(checkPdfStructure(otherGeneration)).toEqual([`/Root ${num} 1 R is not an object in use`]);
    const info = /\/Info (\d+) 0 R/.exec(good)![1];
    const notACatalog = Buffer.from(good.replace(`/Root ${num} 0 R`, `/Root ${info} 0 R`), "latin1");
    expect(checkPdfStructure(notACatalog)).toEqual([`/Root ${info} 0 R is not a catalog`]);
  });

  it("reports an object number listed twice", async () => {
    const good = (await savedWithTable(await samplePdf())).toString("latin1");
    const table = good.lastIndexOf("\nxref\n") + 1;
    const [head, count] = /^xref\n0 (\d+)\n/.exec(good.slice(table))!;
    // A second subsection that lists object 1 again, with the row it already has.
    const row = good.slice(table + head.length + 20, table + head.length + 40);
    const end = table + head.length + 20 * Number(count);
    const twice = good.slice(0, end) + `1 1\n${row}` + good.slice(end);
    expect(checkPdfStructure(Buffer.from(twice, "latin1"))).toEqual(["object 1 is listed twice in the cross-reference table"]);
  });

  it("reports a truncated file and a file that is not a PDF", async () => {
    const good = await savedWithTable(await samplePdf());
    expect(checkPdfStructure(good.subarray(0, good.length - 40))).toEqual(["the file does not end with startxref and %%EOF"]);
    expect(checkPdfStructure(Buffer.from("hello"))).toEqual(["the file does not start with %PDF-"]);
  });

  it("reports an object that is not closed before the next one", async () => {
    const good = (await savedWithTable(await samplePdf())).toString("latin1");
    const problems = checkPdfStructure(Buffer.from(good.replace("endobj", "endobX"), "latin1"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^the object at offset \d+ does not end with endobj before offset \d+$/);
  });

  it("reports object 0 in use", async () => {
    const good = (await savedWithTable(await samplePdf())).toString("latin1");
    const problems = checkPdfStructure(Buffer.from(good.replace("0000000000 65535 f ", "0000000000 65535 n "), "latin1"));
    expect(problems).toContain("object 0 is in use: it must be the head of the free list");
  });

  it("does not vouch for a layout it cannot read", async () => {
    // pdf-lib's default output: objects in object streams, indexed by a cross-reference stream.
    expect(checkPdfStructure(await samplePdf())).toEqual(["startxref does not point at a cross-reference table"]);
    // An incremental update: the last table lists one object and chains to the previous one.
    expect(checkPdfStructure(catalogRedefinedAtGeneration1())).toEqual([
      "the trailer chains to another cross-reference section, which this check does not read",
      "/Size is 19 but the cross-reference table lists objects up to 17",
    ]);
  });
});

describe("structure check before the seal", () => {
  it("never seals a final PDF whose cross-reference table is wrong", async () => {
    const input = inputFor(await samplePdf());
    // The PDF library writes a table with one wrong row, whatever the reason.
    const save = PDFDocument.prototype.save;
    vi.spyOn(PDFDocument.prototype, "save").mockImplementation(async function (this: PDFDocument, options) {
      return withOneWrongOffset(await save.call(this, options));
    });
    const sign = vi.spyOn(SignPdf.prototype, "sign");

    const failure = await buildFinalPdf(input).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PdfStructureError);
    expect((failure as PdfStructureError).message).toMatch(
      /^Final PDF of 0b1c2d3e-0000-4000-8000-000000000002 has an invalid structure; refusing to seal: cross-reference entry of object 1 0 points at /,
    );
    expect((failure as PdfStructureError).problems).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
  });
});
