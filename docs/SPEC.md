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
- The owner can cancel only while a signer or an approver still has to act.
  Once the last of them has acted the envelope is signed: cancelling is refused,
  even during the short time the final PDF is being sealed. If that seal failed,
  the refused cancellation tries it again.

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

The database enforces it:
- triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` on `events`;
- an event is appended inside a transaction that holds a lock on its envelope
  (transaction-scoped advisory lock), so two concurrent writers, on any number
  of connections, never read the same previous hash;
- as a second barrier, `(envelope_id, prev_hash)` is unique: a chain cannot
  fork — an event has at most one successor and an envelope one first event.

## 7. Verification

A public page lets anyone drop a PDF: SignSen hashes it on the server and
tells whether it is a document it sealed, with the envelope title, completion
date and recipients (names, partially masked e-mails). The evidence
certificate carries an ID and a QR code pointing to that page.

## 8. Accounts

Owners (senders) have accounts: e-mail + password (scrypt), sessions in
httpOnly cookies (random token, hashed at rest). Recipients never need an
account.

Forgotten password: the sign-in page links to a form asking for the account's
e-mail address. The answer is the same whether an account exists or not, and
the e-mail is sent without making the answer wait for it. An existing account
receives a personal link with a random 256-bit token (only its SHA-256 is
stored), valid 1 hour and usable once; a new request replaces the previous
link. At most 3 requests per address per hour, and `SIGNIN_IP_LIMIT` per IP
address per hour. Choosing the new password (same rules as at sign-up) spends
the link, closes every session of the account and e-mails the owner that the
password changed. A short password does not spend the link.

## 9. Personalisation (white label)

Name, logo, primary colour, default language and support e-mail come from
configuration. Languages: French and English in v0.1.

## 10. Storage

Records live in **PostgreSQL** (accounts, sessions, envelopes, recipients,
fields, one-time codes, audit trail, rate limits); `DATABASE_URL` is mandatory:
without it the configuration is rejected with an explicit error, no request
can read or write anything and the health check fails. PostgreSQL is the only
supported database.

Files live in the data directory (`DATA_DIR`): documents (content-addressed by
SHA-256, checked on every read), the seal, the instance key and the outbox.
The data directory and its sub-folders are created `0700` and the files in
them `0600`, whatever the process umask; the data directory and its `files`
folder are tightened at start-up when they were left readable by others.

Rules:
- Migrations are applied when an instance first connects to the database, one
  instance at a time (session advisory lock), before any other query. A
  connection that fails is retried by the next request.
- Every change to an envelope — drafting, sending, a recipient's action,
  completion — runs in one transaction that first takes the envelope's lock:
  what it checks (status, turn, one-time code) is still true when it writes,
  whatever the number of connections. A double submission acts once.
- The rate limiter counts in a single atomic statement: concurrent requests
  cannot exceed a limit.
- Dates are stored as integer milliseconds since the epoch (UTC), taken from
  the server clock.
- `GET /healthz` answers `200` only when the configuration is valid and the
  database answers a query, `503` otherwise, and reveals nothing else. Pages
  stream their content, so their own status code cannot tell an operator that
  the database is unreachable: monitoring and the container health check use
  this address.

Installations made with v0.1.0 stored their records in a SQLite file
(`DATA_DIR/signsen.db`). That file is not read anymore and no import tool is
provided.

## 11. Out of scope for v0.1 (planned)

Templates, attachments, comments, reminders and expiry, SMS/WhatsApp code
delivery, RFC 3161 timestamps and PAdES baseline profiles, organisations with
several members, API keys, two-factor sign-in for senders.
