"use server";

import { refresh } from "next/cache";
import { act, decline, requestCode, SIGNATURE_PNG_MAX_BYTES } from "@/server/ceremony";
import { actionError, requestMeta, services, type ActionState } from "@/server/request";

function signatureFrom(formData: FormData) {
  const raw = String(formData.get("signature") ?? "");
  const kind = formData.get("signatureKind") === "typed" ? "typed" : "drawn";
  const prefix = "data:image/png;base64,";
  // Bounded before decoding: base64 is 4/3 of the bytes.
  if (!raw.startsWith(prefix) || raw.length > prefix.length + Math.ceil((SIGNATURE_PNG_MAX_BYTES * 4) / 3) + 4) return undefined;
  return { kind: kind as "drawn" | "typed", png: Buffer.from(raw.slice(prefix.length), "base64") };
}

export async function requestCodeAction(token: string): Promise<ActionState> {
  try {
    await requestCode(await services(), token, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  return { ok: true, message: "code_sent" };
}

export async function actAction(token: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  try {
    await act(
      await services(),
      token,
      {
        code: String(formData.get("code") ?? ""),
        consent: formData.get("consent") === "on",
        signature: signatureFrom(formData),
      },
      await requestMeta(),
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return { ok: true };
}

export async function declineAction(token: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  try {
    await decline(
      await services(),
      token,
      { code: String(formData.get("code") ?? ""), reason: String(formData.get("reason") ?? "") },
      await requestMeta(),
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return { ok: true };
}
