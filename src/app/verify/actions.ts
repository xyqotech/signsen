"use server";

import { DomainError } from "@/server/errors";
import { MAX_PDF_BYTES } from "@/server/pdf/inspect";
import { consumeRate } from "@/server/ratelimit";
import { actionError, requestMeta, services, type ActionState } from "@/server/request";
import { verifyUpload, type PublicEnvelope } from "@/server/verification";

export type VerifyResult = {
  sha256: string;
  envelope: PublicEnvelope | null;
  sealValid: boolean;
  sealReason: string | null;
  signerSubject: string | null;
  signingTime: number | null;
  sealedByThisInstance: boolean;
};

export async function verifyAction(_prev: unknown, formData: FormData): Promise<ActionState & { result?: VerifyResult }> {
  const s = await services();
  try {
    const meta = await requestMeta();
    if (!consumeRate(s.db, `verify:${meta.ip ?? "unknown"}`, 60, 3600_000, s.now())) throw new DomainError("rate_limited");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new DomainError("invalid_pdf");
    if (file.size > MAX_PDF_BYTES * 2) throw new DomainError("pdf_too_large");
    // Analysed in memory and forgotten: uploaded files are never stored.
    const check = verifyUpload(s, Buffer.from(await file.arrayBuffer()));
    return {
      ok: true,
      result: {
        sha256: check.sha256,
        envelope: check.envelope,
        sealValid: check.seal.valid,
        sealReason: check.seal.valid ? null : check.seal.reason,
        signerSubject: check.seal.valid ? check.seal.signerSubject : null,
        signingTime: check.seal.valid ? (check.seal.signingTime?.getTime() ?? null) : null,
        sealedByThisInstance: check.sealedByThisInstance,
      },
    };
  } catch (e) {
    return actionError(e);
  }
}
