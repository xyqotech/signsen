"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  addRecipient,
  attachDocument,
  cancelEnvelope,
  createEnvelope,
  deleteEnvelope,
  removeRecipient,
  resendInvitation,
  sendEnvelope,
  setFields,
  updateEnvelope,
} from "@/server/envelopes";
import { DomainError } from "@/server/errors";
import { getDictionary, placeholderTitles } from "@/i18n/dictionaries";
import { actionError, currentLocale, requestMeta, requireUser, services, type ActionState } from "@/server/request";

const ok: ActionState = { ok: true };

export async function createEnvelopeAction() {
  const user = await requireUser();
  const s = await services();
  const t = getDictionary(await currentLocale());
  const env = await createEnvelope(s, user.id, { title: t.dashboard.untitled }, await requestMeta());
  redirect(`/envelopes/${env.id}`);
}

export async function updateDetailsAction(envelopeId: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await updateEnvelope(
      await services(),
      user.id,
      envelopeId,
      { title: String(formData.get("title") ?? ""), message: String(formData.get("message") ?? "") },
      await requestMeta(),
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return ok;
}

export async function uploadDocumentAction(envelopeId: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const file = formData.get("document");
  try {
    if (!(file instanceof File) || file.size === 0) throw new DomainError("invalid_pdf");
    await attachDocument(
      await services(),
      user.id,
      envelopeId,
      { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
      await requestMeta(),
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return ok;
}

export async function addRecipientAction(envelopeId: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await addRecipient(
      await services(),
      user.id,
      envelopeId,
      {
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        role: String(formData.get("role") ?? "signer") as "signer" | "approver" | "viewer",
        routingOrder: Number(formData.get("routingOrder") ?? 1),
      },
      await requestMeta(),
    );
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return ok;
}

export async function removeRecipientAction(envelopeId: string, recipientId: string) {
  const user = await requireUser();
  await removeRecipient(await services(), user.id, envelopeId, recipientId, await requestMeta());
  refresh();
}

export async function saveFieldsAction(
  envelopeId: string,
  fieldsList: { recipientId: string; page: number; x: number; y: number; width: number; height: number }[],
): Promise<ActionState> {
  const user = await requireUser();
  try {
    await setFields(await services(), user.id, envelopeId, fieldsList, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return ok;
}

/**
 * The editor sends the title and the message along, as they are typed at that
 * moment: they are saved first, so a title that was never saved on its own is
 * not replaced by the placeholder once the envelope is frozen.
 */
export async function sendAction(envelopeId: string, _prev: unknown, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    const s = await services();
    const meta = await requestMeta();
    const title = formData.get("title");
    if (typeof title === "string") {
      await updateEnvelope(s, user.id, envelopeId, { title, message: String(formData.get("message") ?? "") }, meta);
    }
    await sendEnvelope(s, user.id, envelopeId, meta, { placeholderTitles });
  } catch (e) {
    const state = actionError(e);
    // Not sent, but the title and the message may have been saved: show them as they are now.
    refresh();
    return state;
  }
  refresh();
  return ok;
}

export async function cancelAction(envelopeId: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    await cancelEnvelope(await services(), user.id, envelopeId, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  refresh();
  return ok;
}

export async function deleteAction(envelopeId: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    await deleteEnvelope(await services(), user.id, envelopeId, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  redirect("/envelopes");
}

export async function resendAction(envelopeId: string, recipientId: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    await resendInvitation(await services(), user.id, envelopeId, recipientId, await requestMeta());
  } catch (e) {
    return actionError(e);
  }
  return { ok: true, message: "resent" };
}
