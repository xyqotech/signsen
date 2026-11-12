/**
 * Structural check of the PDF the finalisation is about to seal, done on the
 * bytes and without the PDF library that wrote them.
 *
 * It reads the file as a strict reader does — `startxref`, the cross-reference
 * table, the trailer — and checks that the table describes the objects it
 * claims to: readers that trust the table (instead of rebuilding it when it is
 * wrong) show nothing at all otherwise.
 *
 * It only knows the layout `buildFinalPdf` writes: one classic cross-reference
 * table, no cross-reference stream, no incremental update. Anything else is
 * reported as a problem rather than accepted unread. It checks the table
 * against the objects, not what the objects contain.
 */

const MAX_PROBLEMS = 10;

export class PdfStructureError extends Error {
  constructor(
    /** Whose file it is, for the logs: e.g. "Final PDF of <envelope id>". */
    subject: string,
    readonly problems: string[],
  ) {
    super(`${subject} has an invalid structure; refusing to seal: ${problems.join("; ")}`);
    this.name = "PdfStructureError";
  }
}

/** Throws a `PdfStructureError` unless `checkPdfStructure` finds nothing. */
export function assertPdfStructure(pdf: Buffer, subject: string): void {
  const problems = checkPdfStructure(pdf);
  if (problems.length > 0) throw new PdfStructureError(subject, problems);
}

/** Lists what is wrong with the cross-reference table and trailer of `pdf`; empty when it is sound. */
export function checkPdfStructure(pdf: Buffer): string[] {
  const ascii = (from: number, to: number) => pdf.toString("latin1", Math.max(0, from), Math.min(pdf.length, to));

  if (ascii(0, 5) !== "%PDF-") return ["the file does not start with %PDF-"];
  const tailAt = Math.max(0, pdf.length - 48);
  const tail = /startxref\r?\n(\d+)\r?\n%%EOF\s*$/.exec(ascii(tailAt, pdf.length));
  if (!tail) return ["the file does not end with startxref and %%EOF"];
  const xrefOffset = Number(tail[1]);
  const startxrefAt = tailAt + tail.index;
  if (xrefOffset >= startxrefAt || ascii(xrefOffset, xrefOffset + 5) !== "xref\n") {
    return ["startxref does not point at a cross-reference table"];
  }

  // The table: subsections "first count", then `count` entries of 20 bytes each.
  const problems: string[] = [];
  const listed = new Set<number>();
  const inUse = new Map<number, { offset: number; generation: number }>();
  let at = xrefOffset + 5;
  for (;;) {
    const head = /^(\d+) (\d+)\n/.exec(ascii(at, at + 24));
    if (!head) break;
    at += head[0].length;
    const first = Number(head[1]);
    const count = Number(head[2]);
    if (at + 20 * count > startxrefAt) return [`the cross-reference subsection of object ${first} runs past the end of the table`];
    for (let num = first; num < first + count; num++, at += 20) {
      const entry = /^(\d{10}) (\d{5}) ([nf])(?: \n| \r|\r\n)$/.exec(ascii(at, at + 20));
      if (!entry) return [`the cross-reference entry of object ${num} is malformed`];
      if (listed.has(num)) problems.push(`object ${num} is listed twice in the cross-reference table`);
      listed.add(num);
      if (entry[3] === "n") inUse.set(num, { offset: Number(entry[1]), generation: Number(entry[2]) });
    }
  }
  while (at < startxrefAt && /\s/.test(ascii(at, at + 1))) at++;
  if (ascii(at, at + 7) !== "trailer") return ["the cross-reference table is not followed by its trailer"];
  if (listed.size === 0) return ["the cross-reference table is empty"];
  if (inUse.has(0)) problems.push("object 0 is in use: it must be the head of the free list");

  // Each object in use must be exactly where the table says, under the same generation.
  const misplaced: string[] = [];
  const sound: number[] = [];
  for (const [num, { offset, generation }] of inUse) {
    const found = offset < xrefOffset ? /^(\d+) (\d+) obj(?![A-Za-z0-9])/.exec(ascii(offset, offset + 32)) : null;
    if (found && Number(found[1]) === num && Number(found[2]) === generation) {
      sound.push(offset);
    } else {
      const actual = found ? found[0] : offset < xrefOffset ? ascii(offset, offset + 16).split(/[\r\n]/)[0] : "the end of the file";
      misplaced.push(`cross-reference entry of object ${num} ${generation} points at "${actual}"`);
    }
  }
  sound.sort((a, b) => a - b);
  /** Where the object at `sound[i]` stops: the next object, or the table after the last one. */
  const endOf = (i: number) => (i + 1 < sound.length ? sound[i + 1] : xrefOffset);

  const trailer = ascii(at + 7, startxrefAt);
  if (/\/(Prev|XRefStm)(?![A-Za-z0-9])/.test(trailer)) {
    problems.push("the trailer chains to another cross-reference section, which this check does not read");
  }
  const size = /\/Size\s+(\d+)/.exec(trailer);
  const highest = Math.max(...listed);
  if (!size) problems.push("the trailer has no /Size");
  else if (Number(size[1]) !== highest + 1) problems.push(`/Size is ${size[1]} but the cross-reference table lists objects up to ${highest}`);

  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
  if (!root) {
    problems.push("the trailer has no /Root reference");
  } else {
    const entry = inUse.get(Number(root[1]));
    const reference = `/Root ${root[1]} ${root[2]} R`;
    const index = entry ? sound.indexOf(entry.offset) : -1;
    if (!entry || entry.generation !== Number(root[2])) problems.push(`${reference} is not an object in use`);
    // A misplaced entry is already reported; a sound one must hold the catalog.
    else if (index !== -1 && !/\/Type\s*\/Catalog(?![A-Za-z0-9])/.test(ascii(entry.offset, endOf(index)))) problems.push(`${reference} is not a catalog`);
  }

  problems.push(...misplaced);
  // Objects are written back to back: each one is closed before the next starts.
  for (let i = 0; i < sound.length; i++) {
    if (!/endobj\s*$/.test(ascii(endOf(i) - 16, endOf(i)))) {
      problems.push(`the object at offset ${sound[i]} does not end with endobj before offset ${endOf(i)}`);
    }
  }

  return problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`] : problems;
}
