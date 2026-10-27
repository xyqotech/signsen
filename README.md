# SignSen

**Self-hostable, open-source electronic signature for companies, small
businesses and individuals.** Send a PDF, choose who signs, approves or receives a
copy, and get back a sealed document with its evidence certificate. Signers need
no account: a personal link and a one-time code received by e-mail are enough.

*[Version française plus bas.](#signsen--en-français)*

> **Legal level, stated plainly.** SignSen produces **simple electronic
> signatures** backed by an evidence file: one-time code identification,
> explicit consent, document integrity (SHA-256), a hash-chained audit trail and
> a PKCS#7 seal of the final PDF by your instance's certificate. It does **not**
> produce qualified electronic signatures, and it never claims to. Whether a
> simple signature fits your documents depends on your jurisdiction — ask a
> lawyer for acts that require more (some property, family or notarial acts).

## Features

- **Signing workflows** — signers, approvers and copy recipients; sequential
  (routing order) or parallel; resend an invitation (the old link stops
  working); cancel; decline with a reason sent to the sender only.
- **Placing signature boxes** on the rendered PDF: click, drag, resize or use the
  keyboard. Rotated pages are handled.
- **Signing ceremony without account**, mobile-first: draw or type a signature,
  one-time code by e-mail (10 minutes, 5 attempts, 5 codes per hour), explicit
  consent checked before the code is used.
- **Evidence** — append-only audit trail (enforced by the database) chained by
  SHA-256; final PDF with stamped signatures and an evidence certificate
  (participants, identity check, IP address, device, consent, history, seal
  fingerprint, QR code); detached PKCS#7 seal.
- **Public verification** — anyone can drop a PDF to check it is the exact file
  your instance sealed (the file is analysed, never stored); the QR code leads
  to a page with partially masked e-mails.
- **White label** — name, colour, logo, support address, French and English.
- **Small footprint** — one Node.js process, SQLite, files on disk. No external
  service besides your SMTP server.

## Quick start with Docker

```bash
cp .env.example .env        # then edit APP_URL, MAIL_* and branding
docker compose up -d --build
```

SignSen listens on `127.0.0.1:3000`. Put a reverse proxy in front of it that
terminates TLS and **sets `X-Forwarded-For`** (the IP recorded in the evidence
file is the right-most entry of that header). Example with Caddy:

```
sign.example.org {
  reverse_proxy 127.0.0.1:3000
}
```

All state lives in the `/data` volume: `signsen.db` (SQLite), `files/`
(documents), `seal/` (seal certificate and its password), `instance.key`.
**Back up the whole volume** — losing `seal/` or `instance.key` invalidates
pending one-time codes and changes the seal of future documents.

## From source

Requires Node.js ≥ 20.9 (22 recommended).

```bash
npm ci
npm run dev                     # http://localhost:3000, data in ./data
# production
npm run build
DATA_DIR=./data APP_URL=https://sign.example.org scripts/start-standalone.sh
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | Public URL, used in e-mails, QR codes, cookies (`https://` enables secure cookies). |
| `DATA_DIR` | `./data` | Database, documents, seal and instance key. |
| `APP_NAME`, `BRAND_COLOR`, `BRAND_LOGO_URL` | `SignSen`, `#1f6f5c`, — | White label. |
| `DEFAULT_LOCALE` | `fr` | `fr` or `en`; visitors' browser language wins when supported. |
| `SUPPORT_EMAIL` | — | Shown in the footer and e-mails. |
| `ALLOW_SIGNUP` | `true` | Set `false` to close self-registration. |
| `MAIL_TRANSPORT` | `console` | `smtp`, `file` (JSON in `DATA_DIR/outbox`) or `console`. |
| `MAIL_FROM`, `SMTP_URL` | — | Sender address and SMTP connection URL. |
| `SIGNIN_IP_LIMIT` | `50` | Sign-in attempts per IP address and 15 minutes. |
| `SEAL_P12_PATH`, `SEAL_P12_PASSWORD` | — | Your own seal certificate (see below). |

### The seal certificate

Without configuration, SignSen generates a **self-signed** RSA-3072 seal on first
start. It proves that a document was not modified since your instance sealed it,
checked against the fingerprint shown on every evidence certificate and on the
verification page. PDF readers will show the seal as "validity unknown" because
it does not chain to a public trust list.

To have readers trust the seal, provide a document-signing certificate from a
certification authority as a PKCS#12 file (`SEAL_P12_PATH` /
`SEAL_P12_PASSWORD`). Certificate and identity providers are generic: the code
names no vendor.

## Tests

```bash
npm test             # unit and integration tests (Vitest, temporary database per test)
npm run test:e2e     # end-to-end (Playwright, production build, fresh database)
```

The end-to-end suite reads the e-mails the application really sent (file
transport) to follow invitation links and one-time codes. It uses page objects
(`e2e/pages`), flows (`e2e/flows`) and fixtures (`e2e/fixtures`), and runs on a
desktop and a phone profile.

## How it is built

- `docs/SPEC.md` — the functional contract the tests are written against.
- `src/server/` — the domain, independent from the web framework: accounts,
  envelopes and routing, signing ceremony, completion, PDF stamping, evidence
  certificate and seal, verification, hash-chained audit trail.
- `src/app/` — Next.js (App Router) pages and Server Actions, a thin layer over
  the domain. `src/proxy.ts` answers real 404s before rendering.
- `drizzle/` — SQLite migrations (applied automatically on start).

## Roadmap

Templates · attachments and comments · reminders and expiry · SMS and WhatsApp
code delivery · RFC 3161 timestamps and PAdES baseline profiles · PostgreSQL ·
organisations with several members · API keys and webhooks · two-factor sign-in
for senders.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[Apache License 2.0](LICENSE).

---

# SignSen — en français

**Signature électronique libre et auto-hébergeable pour les entreprises, les PME
et les particuliers.** Envoyez un PDF, indiquez qui signe, approuve ou reçoit une
copie, et récupérez un document scellé accompagné de son certificat de preuve.
Les signataires n'ont besoin d'aucun compte : un lien personnel et un code reçu
par e-mail suffisent.

> **Niveau juridique, sans détour.** SignSen délivre une **signature
> électronique simple** appuyée par un dossier de preuve : identification par
> code à usage unique, consentement explicite, intégrité du document (SHA-256),
> journal d'audit chaîné et sceau PKCS#7 du PDF final par le certificat de votre
> instance. Ce n'est **pas** une signature électronique qualifiée, et l'outil ne
> le prétend jamais. Selon votre pays et la nature de l'acte (certains actes
> immobiliers, familiaux ou notariés), demandez conseil à un juriste.

**Démarrage rapide** : `cp .env.example .env`, ajustez `APP_URL`, l'e-mail et
votre marque, puis `docker compose up -d --build`. Placez un reverse proxy (TLS)
devant le port 3000, et sauvegardez le volume `/data` en entier.

Fonctions, configuration, sceau et tests : voir la version anglaise ci-dessus,
qui fait référence.
