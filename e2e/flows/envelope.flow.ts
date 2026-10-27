import { expect } from "@playwright/test";
import type { CeremonyPage } from "../pages/ceremony.page";
import type { DashboardPage } from "../pages/dashboard.page";
import type { EnvelopePage, Role } from "../pages/envelope.page";
import type { Mailbox } from "../support/mailbox";
import { samplePdf } from "../support/test-data";

export interface Participant {
  person: { name: string; email: string };
  role?: Role;
  order?: number;
  /** Page where the signature box goes (signers only). */
  fieldPage?: number;
}

/** Creates a draft with a document, recipients and one box per signer — not sent. */
export async function prepareEnvelope(
  dashboard: DashboardPage,
  envelope: EnvelopePage,
  opts: { title: string; message?: string; participants: Participant[]; pages?: number },
): Promise<string> {
  await dashboard.goto();
  const url = await dashboard.newEnvelope();
  await envelope.setDetails(opts.title, opts.message ?? "");
  await envelope.upload(await samplePdf({ pages: opts.pages ?? 2, title: opts.title }));
  for (const p of opts.participants) await envelope.addRecipient(p.person, p.role ?? "signer", p.order ?? 1);
  const signers = opts.participants.filter((p) => (p.role ?? "signer") === "signer");
  for (const [i, p] of signers.entries()) {
    await envelope.placeField(p.person.name, p.fieldPage ?? 1, 0.55, 0.62 + i * 0.1);
  }
  if (signers.length) {
    await expect(envelope.fields()).toHaveCount(signers.length);
    await envelope.saveFields();
  }
  return url;
}

export async function sendEnvelopeTo(
  dashboard: DashboardPage,
  envelope: EnvelopePage,
  opts: { title: string; message?: string; participants: Participant[]; pages?: number },
) {
  const url = await prepareEnvelope(dashboard, envelope, opts);
  await envelope.send();
  return url;
}

/** Opens the invitation, gets the code by e-mail, and signs or approves. */
export async function actFromEmail(
  ceremony: CeremonyPage,
  mailbox: Mailbox,
  who: { name: string; email: string },
  how: "draw" | "type" | "approve" = "draw",
) {
  await ceremony.open(await mailbox.invitationLink(who.email));
  const before = mailbox.messagesTo(who.email).length;
  await ceremony.requestCode();
  await ceremony.fillCode(await mailbox.nextCode(who.email, before));
  if (how === "draw") await ceremony.drawSignature();
  if (how === "type") await ceremony.typeSignature(who.name);
  await ceremony.consent();
  if (how === "approve") await ceremony.approve();
  else await ceremony.sign();
  await expect(ceremony.page.getByText(/Merci, votre (signature|approbation) est enregistrée/)).toBeVisible();
}
