/**
 * Synthetic PDFs written byte by byte, for tests only: the tests choose every
 * object number, generation and cross-reference section, which no PDF library
 * lets them do. They reproduce what editors leave behind when they save a
 * change as an incremental update (ISO 32000-1, 7.5.6).
 */

export interface RawObject {
  num: number;
  /** Generation number, 0 unless the number is being reused. */
  gen?: number;
  /** Everything between `obj` and `endobj`. */
  body: string;
}

export interface FreeEntry {
  num: number;
  /** Generation the number will have when it is used again. */
  gen: number;
  /** Next free object number (0 ends the list). */
  next: number;
}

interface Revision {
  objects: RawObject[];
  /** Objects written in the body that the cross-reference section does not list. */
  unlisted?: RawObject[];
  free?: FreeEntry[];
  /** Entries of the trailer dictionary besides /Size and /Prev. */
  trailer: string;
  size: number;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Appends one revision (objects, cross-reference section, trailer) to `previous`, or starts a file. */
function writeRevision(previous: string | null, revision: Revision): string {
  let out = previous ?? "%PDF-1.4\n%âãÏÓ\n";
  const rows = new Map<number, string>();
  for (const o of revision.objects) {
    rows.set(o.num, `${pad(out.length, 10)} ${pad(o.gen ?? 0, 5)} n \n`);
    out += `${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`;
  }
  for (const o of revision.unlisted ?? []) out += `${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`;
  for (const f of revision.free ?? []) rows.set(f.num, `${pad(f.next, 10)} ${pad(f.gen, 5)} f \n`);

  const xrefOffset = out.length;
  out += "xref\n";
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out += `${numbers[i]} ${j - i + 1}\n`;
    for (let n = i; n <= j; n++) out += rows.get(numbers[n]);
    i = j + 1;
  }
  const prev = previous === null ? "" : ` /Prev ${/startxref\n(\d+)\n%%EOF\n$/.exec(previous)![1]}`;
  out += `trailer\n<< /Size ${revision.size} ${revision.trailer}${prev} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return out;
}

const stream = (content: string) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
const pageText = (label: string) => stream(`BT /F1 14 Tf 60 780 Td (${label}) Tj ET`);

const PAGES = 7;
const pageNum = (i: number) => 2 + 2 * i;
const contentNum = (i: number) => 3 + 2 * i;
/** Object numbers of the first revision: with 7 pages the catalog is object 17. */
export const NUM = { font: 1, firstPage: pageNum(0), firstContent: contentNum(0), pages: 2 + 2 * PAGES, catalog: 3 + 2 * PAGES, info: 4 + 2 * PAGES };
export const ORIGINAL_PAGE_COUNT = PAGES;

const pageObject = (i: number, contents: string | null) =>
  `<< /Type /Page /Parent ${NUM.pages} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${NUM.font} 0 R >> >>${contents ? ` /Contents ${contents}` : ""} >>`;
const pagesObject = (kids: number[]) => `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

/** A 7-page document as a PDF 1.4 writer produces it: one section, every generation 0. */
function firstRevision(): string {
  const objects: RawObject[] = [{ num: NUM.font, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" }];
  for (let i = 0; i < PAGES; i++) {
    objects.push({ num: pageNum(i), body: pageObject(i, `${contentNum(i)} 0 R`) });
    objects.push({ num: contentNum(i), body: pageText(`Synthetic agreement - page ${i + 1}`) });
  }
  objects.push({ num: NUM.pages, body: pagesObject(Array.from({ length: PAGES }, (_, i) => pageNum(i))) });
  objects.push({ num: NUM.catalog, body: `<< /Type /Catalog /Pages ${NUM.pages} 0 R >>` });
  objects.push({ num: NUM.info, body: "<< /Producer (Synthetic PDF 1.4 writer) /Title (Synthetic agreement) >>" });
  return writeRevision(null, {
    objects,
    free: [{ num: 0, gen: 65535, next: 0 }],
    trailer: `/Root ${NUM.catalog} 0 R /Info ${NUM.info} 0 R`,
    size: NUM.info + 1,
  });
}

const bytes = (pdf: string) => Buffer.from(pdf, "latin1");

/**
 * The catalog is replaced by an incremental update that gives it generation 1:
 * the file holds `17 0 obj` (old) and `17 1 obj` (new), its second
 * cross-reference section is the single subsection `17 1` whose entry has
 * generation 00001, and its trailer says `/Root 17 1 R` with a `/Prev`.
 */
export function catalogRedefinedAtGeneration1(): Buffer {
  return bytes(
    writeRevision(firstRevision(), {
      objects: [{ num: NUM.catalog, gen: 1, body: `<< /Type /Catalog /Pages ${NUM.pages} 0 R /Lang (fr-SN) /PageLayout /OneColumn >>` }],
      trailer: `/Root ${NUM.catalog} 1 R /Info ${NUM.info} 0 R`,
      size: NUM.info + 1,
    }),
  );
}

/** An incremental update that adds an eighth page and rewrites the page tree node under the same generation. */
export function updatedWithoutGenerationChange(): Buffer {
  const page = NUM.info + 1;
  const content = NUM.info + 2;
  return bytes(
    writeRevision(firstRevision(), {
      objects: [
        { num: NUM.pages, body: pagesObject([...Array.from({ length: PAGES }, (_, i) => pageNum(i)), page]) },
        { num: page, body: pageObject(PAGES, `${content} 0 R`) },
        { num: content, body: pageText("Synthetic agreement - page added by an update") },
      ],
      trailer: `/Root ${NUM.catalog} 0 R /Info ${NUM.info} 0 R`,
      size: content + 1,
    }),
  );
}

/** First update: the text of page 1 (object 3) is freed and the page loses its content. */
function contentOfPage1Freed(): string {
  return writeRevision(firstRevision(), {
    objects: [{ num: NUM.firstPage, body: pageObject(0, null) }],
    free: [
      { num: 0, gen: 65535, next: NUM.firstContent },
      { num: NUM.firstContent, gen: 1, next: 0 },
    ],
    trailer: `/Root ${NUM.catalog} 0 R /Info ${NUM.info} 0 R`,
    size: NUM.info + 1,
  });
}

/** An object freed by an update and never used again: its bytes stay in the file, the table says it is free. */
export function objectFreedNotReused(): Buffer {
  return bytes(contentOfPage1Freed());
}

/** A second update uses the freed number again, with generation 1, for the new text of page 1. */
export function objectFreedThenReused(): Buffer {
  return bytes(
    writeRevision(contentOfPage1Freed(), {
      objects: [
        { num: NUM.firstContent, gen: 1, body: pageText("Synthetic agreement - page 1 as revised") },
        { num: NUM.firstPage, body: pageObject(0, `${NUM.firstContent} 1 R`) },
      ],
      free: [{ num: 0, gen: 65535, next: 0 }],
      trailer: `/Root ${NUM.catalog} 0 R /Info ${NUM.info} 0 R`,
      size: NUM.info + 1,
    }),
  );
}

/**
 * Not a conforming file: a second catalog with generation 1 lies in the body,
 * but no cross-reference section lists it and the trailer still names
 * `17 0 R`. Readers that follow the table never see it.
 */
export function unlistedHigherGeneration(): Buffer {
  return bytes(
    writeRevision(firstRevision(), {
      objects: [],
      unlisted: [{ num: NUM.catalog, gen: 1, body: `<< /Type /Catalog /Pages ${NUM.pages} 0 R /Lang (stray) >>` }],
      free: [{ num: 0, gen: 65535, next: 0 }],
      trailer: `/Root ${NUM.catalog} 0 R /Info ${NUM.info} 0 R`,
      size: NUM.info + 1,
    }),
  );
}

/**
 * Corrupts a PDF that has a classic cross-reference table: the offset of its
 * first object in use is moved by one byte, as a writer that miscounts would.
 */
export function withOneWrongOffset(pdf: Uint8Array): Buffer {
  const text = Buffer.from(pdf).toString("latin1");
  const table = text.lastIndexOf("\nxref\n");
  const row = /(\d{10}) 00000 n /.exec(text.slice(table))!;
  const at = table + row.index;
  return Buffer.from(text.slice(0, at) + pad(Number(row[1]) + 1, 10) + text.slice(at + 10), "latin1");
}
