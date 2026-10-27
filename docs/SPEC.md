# SignSen — Functional specification (v0.1)

SignSen is a self-hostable, open-source electronic signature application for
companies, small businesses and individuals. This document is the contract the
test suite is written against.

## 1. Legal level — stated honestly

SignSen produces **simple electronic signatures** backed by a strong evidence
file: signer identity check by one-time code, explicit consent, document
integrity (SHA-256), a tamper-evident audit trail and a cryptographic seal of
the final PDF (detached PKCS#7 signature, `adbe.pkcs7.detached`) with the
instance's own certificate.

SignSen does **not** produce qualified electronic signatures. A qualified
signature requires a qualified trust service provider; SignSen never claims
that level, in the UI or in the documents it generates. Certificate and
identity providers are generic plugins: the core names no vendor.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Envelope** | A signing request: one PDF, a title, an optional message, an ordered list of recipients. |
| **Recipient** | A person taking part in an envelope. Role: `signer` (signs), `approver` (approves without signing), `viewer` (receives the final copy). |
| **Routing order** | Integer per recipient. Recipients with the same order act in parallel; the next order is notified only when the current one is done. |
| **Field** | A signature box placed on a page of the PDF, assigned to one signer. Coordinates are stored as ratios of the page size (0..1). |
| **Ceremony** | The signing flow a recipient follows from the link in their invitation. |
| **Evidence certificate** | Pages appended to the final PDF summarising who did what, when, and how they were verified. |

## 3. Envelope lifecycle

```
draft ──send──▶ in_progress ──last action──▶ completed
  │                  │
  │                  ├──a recipient declines──▶ declined
  │                  └──owner cancels────────▶ cancelled
  └──owner deletes (draft only)
```

Recipient status: `waiting` (its order has not come) → `notified` → `viewed`
→ `signed` | `approved` | `declined`. Viewers stay `waiting` until completion,
then become `notified`.

Rules:
- An envelope can be sent only if it has a document, at least one signer or
  approver, and every signer has at least one field.
- Once sent, document, recipients and fields are frozen.
- Only the owner of an envelope can see it in the dashboard, send, cancel or
  delete it.
- A declined or cancelled envelope is final: nobody can act on it anymore.

## 4. Ceremony (recipient side, no account needed)

1. The invitation e-mail contains a personal link with a random 256-bit
   token. Only its SHA-256 is stored.
2. Opening the link shows the document, the sender and the message. The first
   opening records a `viewed` event.
3. Before acting, the recipient proves control of the e-mail address with a
   6-digit one-time code (SMS is planned): valid 10 minutes,
   5 attempts max, a new code invalidates the previous one, at most 5 codes per
   hour per recipient.
4. The recipient must tick an explicit consent box ("I have read the document
   and I sign it electronically").
5. A signer draws or types their signature; it is applied to all their fields.
   An approver confirms without a signature image.
6. Instead of acting, a recipient may decline with a reason (1 to 500 chars).
   The reason is shown to the owner.
7. Consent is checked before the code is consumed, so a missing tick never
   burns a valid code.

## 5. Completion

When the last signer/approver acts:
1. Signature images are stamped into their fields.
2. The evidence certificate is appended.
3. The PDF is sealed (detached PKCS#7, `adbe.pkcs7.detached`) with the
   instance certificate; its signing time is the completion time.
4. The SHA-256 of the sealed PDF is recorded.
5. Every recipient and the owner receive the final document.

## 6. Audit trail

Append-only `events` table. Each event stores the SHA-256 of the previous
event of the same envelope and its own hash (`hash = sha256(prev_hash ||
canonical_json(event))`). Verification walks the chain; any edit or deletion
breaks it. Each event records actor, IP address and user agent when known.

## 7. Verification

A public page lets anyone drop a PDF: SignSen hashes it on the server and
tells whether it is a document it sealed, with the envelope title, completion
date and recipients (names, partially masked e-mails). The evidence
certificate carries an ID and a QR code pointing to that page.

## 8. Accounts

Owners (senders) have accounts: e-mail + password (scrypt), sessions in
httpOnly cookies (random token, hashed at rest). Recipients never need an
account.

## 9. Personalisation (white label)

Name, logo, primary colour, default language and support e-mail come from
configuration. Languages: French and English in v0.1.

## 10. Out of scope for v0.1 (planned)

Templates, attachments, comments, reminders and expiry, SMS/WhatsApp code
delivery, RFC 3161 timestamps and PAdES baseline profiles, PostgreSQL,
organisations with several members, API keys, two-factor sign-in for senders.
