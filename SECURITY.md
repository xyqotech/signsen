# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting (repository → *Security* → *Report a vulnerability*). You will get an
answer within a week; fixes are released as soon as they are ready and credited
to you unless you prefer otherwise.

## What SignSen protects, and how

| Threat | Mitigation |
| --- | --- |
| Someone other than the recipient signs | Personal 256-bit link (only its SHA-256 is stored) **and** a 6-digit one-time code sent to the recipient's address: valid 10 min, 5 attempts, 5 codes per hour, a new code replaces the old one. |
| A signed document is altered | SHA-256 of the original and the final PDF recorded; final PDF sealed (PKCS#7); verification refuses any byte added after sealing. |
| The audit trail is rewritten | Events are hash-chained per request and the database refuses updates and deletions; the chain is verified before sealing. |
| A sender reads another sender's requests | Every read and write checks ownership and answers "not found"; `proxy.ts` returns a real 404 before rendering. |
| Signing links leak to third parties | `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on signing pages, links rotate when an invitation is resent. |
| Password guessing | scrypt hashes, throttling per account and per IP, identical answers for unknown accounts and wrong passwords. |
| Account takeover through "forgot password" | Single-use 256-bit link (only its SHA-256 is stored), valid 1 hour, replaced by any newer request; same answer for unknown addresses; 3 requests per address per hour; a reset closes every session and e-mails the owner. |
| Another account on the server reads the data | `DATA_DIR` and its folders are `0700`; the database, its `-wal`/`-shm` files, documents, seal and instance key are `0600`, whatever the umask. |
| Clickjacking, MIME sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`. |
| CSRF | Server Actions check the request origin; session cookie is `SameSite=Lax`, `HttpOnly`, `Secure` over HTTPS. |

## Operator responsibilities

- Serve SignSen over **HTTPS only**, behind a reverse proxy that overwrites
  `X-Forwarded-For` (the evidence file records the right-most entry).
- **Back up `DATA_DIR`** (database, documents, seal, instance key) and keep the
  backups encrypted: they contain personal data and signed documents.
- Keep `DATA_DIR` readable by the service account only. SignSen creates and
  tightens it (`0700`, files `0600`), but cannot do so on a folder it does not
  own: it then logs a warning.
- Comply with the data-protection law that applies to you (retention, purpose,
  information of signers, transfers abroad).

## Known limits

- One-time codes are delivered by e-mail: whoever controls the mailbox controls
  the signature. SMS/WhatsApp delivery is on the roadmap.
- The default seal certificate is self-signed; see the README to use one issued
  by a certification authority.
- No RFC 3161 timestamp yet: the signing time comes from the server clock.
