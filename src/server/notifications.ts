import type { Locale } from "./config";
import type { MailMessage } from "./mail";

interface Brand {
  name: string;
  supportEmail?: string;
}

function footer(brand: Brand, locale: Locale) {
  const support = brand.supportEmail
    ? locale === "fr"
      ? `\nAssistance : ${brand.supportEmail}`
      : `\nSupport: ${brand.supportEmail}`
    : "";
  return locale === "fr"
    ? `\n\n—\n${brand.name}. Ce message est automatique.${support}`
    : `\n\n—\n${brand.name}. This message is automatic.${support}`;
}

export function passwordResetMail(p: { to: string; locale: Locale; brand: Brand; name: string; link: string }): MailMessage {
  const fr = p.locale === "fr";
  return {
    to: p.to,
    subject: fr ? "Réinitialiser votre mot de passe" : "Reset your password",
    text:
      (fr
        ? `Bonjour ${p.name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien :\n${p.link}\n\nIl est valable 1 heure et ne sert qu'une fois. Si vous n'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.`
        : `Hello ${p.name},\n\nTo choose a new password, open this link:\n${p.link}\n\nIt is valid for 1 hour and works only once. If you did not ask for it, ignore this message: your password stays the same.`) +
      footer(p.brand, p.locale),
  };
}

export function passwordChangedMail(p: { to: string; locale: Locale; brand: Brand; name: string; forgotLink: string }): MailMessage {
  const fr = p.locale === "fr";
  return {
    to: p.to,
    subject: fr ? "Votre mot de passe a été modifié" : "Your password was changed",
    text:
      (fr
        ? `Bonjour ${p.name},\n\nLe mot de passe de votre compte ${p.brand.name} vient d'être modifié, et toutes vos sessions ont été fermées.\n\nSi vous n'êtes pas à l'origine de ce changement, choisissez tout de suite un nouveau mot de passe :\n${p.forgotLink}`
        : `Hello ${p.name},\n\nThe password of your ${p.brand.name} account was just changed, and all your sessions were closed.\n\nIf you did not make this change, choose a new password right away:\n${p.forgotLink}`) +
      footer(p.brand, p.locale),
  };
}

export function invitationMail(p: {
  to: string;
  locale: Locale;
  brand: Brand;
  recipientName: string;
  senderName: string;
  title: string;
  message: string | null;
  role: "signer" | "approver";
  link: string;
}): MailMessage {
  const fr = p.locale === "fr";
  const action = fr
    ? p.role === "signer"
      ? "à signer"
      : "à approuver"
    : p.role === "signer"
      ? "to sign"
      : "to approve";
  const note = p.message ? (fr ? `\n\nMessage de ${p.senderName} :\n${p.message}` : `\n\nMessage from ${p.senderName}:\n${p.message}`) : "";
  const text = fr
    ? `Bonjour ${p.recipientName},\n\n${p.senderName} vous envoie « ${p.title} » ${action}.${note}\n\nOuvrir le document :\n${p.link}\n\nCe lien vous est personnel : ne le transférez pas. Un code à usage unique vous sera demandé avant d'agir.`
    : `Hello ${p.recipientName},\n\n${p.senderName} sent you "${p.title}" ${action}.${note}\n\nOpen the document:\n${p.link}\n\nThis link is personal: do not forward it. You will be asked for a one-time code before acting.`;
  return {
    to: p.to,
    subject: fr ? `${p.senderName} vous envoie « ${p.title} » ${action}` : `${p.senderName} sent you "${p.title}" ${action}`,
    text: text + footer(p.brand, p.locale),
  };
}

export function otpMail(p: { to: string; locale: Locale; brand: Brand; code: string; title: string }): MailMessage {
  const fr = p.locale === "fr";
  return {
    to: p.to,
    subject: fr ? `Votre code : ${p.code}` : `Your code: ${p.code}`,
    text:
      (fr
        ? `Votre code pour « ${p.title} » : ${p.code}\n\nIl est valable 10 minutes. Ne le communiquez à personne : ${p.brand.name} ne vous le demandera jamais par téléphone.`
        : `Your code for "${p.title}": ${p.code}\n\nIt is valid for 10 minutes. Never share it: ${p.brand.name} will never ask for it by phone.`) +
      footer(p.brand, p.locale),
  };
}

export function completedMail(p: {
  to: string;
  locale: Locale;
  brand: Brand;
  name: string;
  title: string;
  fileName: string;
  pdf: Buffer;
  sha256: string;
}): MailMessage {
  const fr = p.locale === "fr";
  return {
    to: p.to,
    subject: fr ? `Terminé : « ${p.title} »` : `Completed: "${p.title}"`,
    text:
      (fr
        ? `Bonjour ${p.name},\n\nTous les participants ont agi sur « ${p.title} ». Le document final, scellé et accompagné de son certificat de preuve, est joint à ce message.\n\nEmpreinte SHA-256 : ${p.sha256}`
        : `Hello ${p.name},\n\nEveryone has acted on "${p.title}". The final document, sealed and followed by its evidence certificate, is attached.\n\nSHA-256: ${p.sha256}`) +
      footer(p.brand, p.locale),
    attachments: [{ filename: p.fileName, content: p.pdf, contentType: "application/pdf" }],
  };
}

export function declinedMail(p: {
  to: string;
  locale: Locale;
  brand: Brand;
  name: string;
  title: string;
  declinedBy: string;
  /** Shown to the sender only; null for the other participants. */
  reason: string | null;
}): MailMessage {
  const fr = p.locale === "fr";
  const reason = p.reason ? (fr ? `\n\nMotif :\n${p.reason}` : `\n\nReason:\n${p.reason}`) : "";
  return {
    to: p.to,
    subject: fr ? `Refusé : « ${p.title} »` : `Declined: "${p.title}"`,
    text:
      (fr
        ? `Bonjour ${p.name},\n\n${p.declinedBy} a refusé « ${p.title} ». La demande est close.${reason}`
        : `Hello ${p.name},\n\n${p.declinedBy} declined "${p.title}". The request is closed.${reason}`) +
      footer(p.brand, p.locale),
  };
}

export function cancelledMail(p: { to: string; locale: Locale; brand: Brand; name: string; title: string; senderName: string }): MailMessage {
  const fr = p.locale === "fr";
  return {
    to: p.to,
    subject: fr ? `Annulé : « ${p.title} »` : `Cancelled: "${p.title}"`,
    text:
      (fr
        ? `Bonjour ${p.name},\n\n${p.senderName} a annulé « ${p.title} ». Vous n'avez plus rien à faire.`
        : `Hello ${p.name},\n\n${p.senderName} cancelled "${p.title}". Nothing more is needed from you.`) +
      footer(p.brand, p.locale),
  };
}
