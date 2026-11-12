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
- **Small footprint** — one Node.js process, a PostgreSQL database, files on
  disk. No external service besides your SMTP server.

## Quick start with Docker

```bash
cp .env.example .env        # then set POSTGRES_PASSWORD, APP_URL, MAIL_* and branding
docker compose up -d --build
```

`POSTGRES_PASSWORD` has no default: choose one (letters and digits, e.g.
`openssl rand -hex 24`). While it is empty the database refuses to initialise —
`docker compose logs db` says so — and SignSen is not started. The compose file
starts two containers: SignSen and its PostgreSQL database (`db`, version
pinned, not reachable from outside the compose network).

SignSen listens on `127.0.0.1:3000` (`SIGNSEN_HOST_PORT` changes the host port).
Put a reverse proxy in front of it that terminates TLS and **sets
`X-Forwarded-For`** (the IP recorded in the evidence file is the right-most
entry of that header). Example with Caddy:

```
sign.example.org {
  reverse_proxy 127.0.0.1:3000
}
```

`GET /healthz` answers `200` only when SignSen has a valid configuration and
reaches its database, `503` otherwise: point your monitoring at it (the
container health check does). Pages stream their content, so their own status
code stays `200` even when the database is down.

### Published image

Every commit on `main` that passes the tests is built, started once against an
empty database, and only then published to
[`ghcr.io/xyqotech/signsen`](https://github.com/xyqotech/signsen/pkgs/container/signsen)
(`linux/amd64` and `linux/arm64`, under the same tags):

| Tag | Points to |
| --- | --- |
| `sha-<commit>` | exactly that commit — the tag to deploy |
| `main` | the latest commit on `main` — moves at every merge |
| `1.2.3`, `1.2`, `latest` | a release, once a `v1.2.3` tag is pushed |

To run the published image instead of building it, replace the `build:` and
`image:` lines of the `signsen` service in `docker-compose.yml` with a pinned
tag: `image: ghcr.io/xyqotech/signsen:sha-<commit>`. Deploy a `sha-` or version tag,
never `main` or `latest`: a tag that moves makes two servers started on
different days run different code.

### Where the state lives, and how to back it up

| What | Where |
| --- | --- |
| Accounts, requests, recipients, audit trail | PostgreSQL — the `signsen-db` volume of the `db` service |
| Documents (`files/`), seal certificate and its password (`seal/`), `instance.key` | the `signsen-data` volume, mounted on `/data` |

**Back up both, together**: a database without its documents, or documents
without their database, cannot be used. Losing `seal/` or `instance.key`
invalidates pending one-time codes and changes the seal of future documents.

```bash
# 1. the database (consistent snapshot, the application can stay up)
docker compose exec -T db pg_dump -U signsen -d signsen --format=custom > signsen-db.dump
# 2. the files
docker compose exec -T signsen tar -czf - -C /data . > signsen-data.tar.gz
```

To restore on a new host, before opening it to users: create `.env`, start
the database alone and load the dump, start SignSen, put the files back, then
restart SignSen so that it loads the restored instance key.

```bash
docker compose up -d db
docker exec -i "$(docker compose ps -q db)" pg_restore -U signsen -d signsen --clean --if-exists < signsen-db.dump
docker compose up -d
docker exec -i "$(docker compose ps -q signsen)" tar -xzf - -C /data < signsen-data.tar.gz
docker compose restart signsen
```

Keep the backups encrypted: they contain personal data and signed documents.
Moving to a new PostgreSQL major version is a dump and a restore, never a
change of image tag on an existing volume.

### Upgrading from 0.1.0 (SQLite)

SignSen 0.1.0 kept its records in a SQLite file, `signsen.db`, in the data
directory. This version stores them in PostgreSQL only, and **does not read
that file: no import tool is provided.** An instance upgraded in place starts
with an empty database — accounts, requests and audit trails of 0.1.0 are not
carried over, although `files/`, `seal/` and `instance.key` are still used.
If you need that history, keep running 0.1.0 (or keep its `/data` volume
untouched as an archive) and start this version as a new instance.

## From source

Requires Node.js ≥ 20.9 (22 recommended) and a PostgreSQL server (developed and
tested with PostgreSQL 18).

```bash
npm ci
export DATABASE_URL=postgres://signsen:secret@localhost:5432/signsen
npm run dev                     # http://localhost:3000, files in ./data
# production
npm run build
DATA_DIR=./data APP_URL=https://sign.example.org scripts/start-standalone.sh
```

The schema is created and upgraded at start-up (migrations in `drizzle/`); the
database role must be allowed to create schemas and tables in its database
(owning the database is enough).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | Public URL, used in e-mails, QR codes, cookies (`https://` enables secure cookies). |
| `DATABASE_URL` | — (**required**) | PostgreSQL connection string, e.g. `postgres://signsen:secret@localhost:5432/signsen`. Without it nothing works: `scripts/start-standalone.sh` refuses to start, every request fails with an explicit configuration error in the logs, and `/healthz` answers `503`. `docker compose` builds it from `POSTGRES_PASSWORD`. |
| `POSTGRES_PASSWORD` | — (**required** with `docker compose`) | Password of the bundled database. Letters and digits only: it is embedded in a URL. |
| `SIGNSEN_HOST_PORT` | `3000` | `docker compose` only: host port, bound to `127.0.0.1`. |
| `DATA_DIR` | `./data` | Documents, seal, instance key and file outbox. |
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

Both suites run on a real PostgreSQL server, given by `TEST_DATABASE_URL`: a
connection to any database of that server (usually `postgres`) with a role
allowed to create databases. A throwaway container is enough:

```bash
docker run -d --name signsen-test-db -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18.6-alpine3.24
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres

npm test             # unit and integration tests (Vitest, one temporary database per test)
npm run test:e2e     # end-to-end (Playwright, production build, database recreated for the run)
```

Unit tests create and drop their own `signsen_test_*` databases; the end-to-end
run drops and recreates `signsen_e2e_<port>`. Nothing else on the server is
touched.

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
- `drizzle/` — PostgreSQL migrations (applied automatically on start). The
  audit trail is protected there: triggers refuse `UPDATE`, `DELETE` and
  `TRUNCATE` on `events`, and a unique constraint forbids a forked chain.

## Roadmap

Templates · attachments and comments · reminders and expiry · SMS and WhatsApp
code delivery · RFC 3161 timestamps and PAdES baseline profiles · organisations
with several members · API keys and webhooks · two-factor sign-in for senders.

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

**Démarrage rapide** : `cp .env.example .env`, choisissez `POSTGRES_PASSWORD`
(obligatoire, sans valeur par défaut : lettres et chiffres, par exemple
`openssl rand -hex 24`), ajustez `APP_URL`, l'e-mail et votre marque, puis
`docker compose up -d --build`. Deux conteneurs démarrent : SignSen et sa base
PostgreSQL (version épinglée, inaccessible hors du réseau compose). Tant que le
mot de passe est vide, la base refuse de s'initialiser (`docker compose logs
db` l'indique) et SignSen ne démarre pas. Placez un reverse proxy (TLS) devant
le port 3000.

**Image publiée** : chaque commit de `main` qui passe les tests est construit,
démarré une fois sur une base vide, puis publié sur `ghcr.io/xyqotech/signsen`
(`linux/amd64` et `linux/arm64`, sous les mêmes étiquettes). Déployez une
étiquette `sha-<commit>` ou de version, jamais `main` ni `latest`, qui changent
de contenu d'un jour à l'autre.

**Stockage et sauvegarde** : les comptes, demandes, destinataires et le journal
d'audit sont dans PostgreSQL (volume `signsen-db`) ; les documents, le sceau et
la clé d'instance sont dans le volume `/data` (`signsen-data`). Sauvegardez
**les deux ensemble** — l'un sans l'autre est inutilisable :

```bash
docker compose exec -T db pg_dump -U signsen -d signsen --format=custom > signsen-db.dump
docker compose exec -T signsen tar -czf - -C /data . > signsen-data.tar.gz
```

Sans Docker, la variable `DATABASE_URL` (chaîne de connexion PostgreSQL) est
obligatoire : sans elle, `scripts/start-standalone.sh` refuse de démarrer.
Pour la supervision, `GET /healthz` répond `200` uniquement quand la
configuration est valide et que la base répond, `503` sinon (les pages, elles,
répondent `200` même base arrêtée, car leur contenu est diffusé en flux).

**Mise à jour depuis la 0.1.0 (SQLite) — rupture.** La version 0.1.0 conservait
ses données dans un fichier SQLite (`signsen.db`). Cette version n'utilise que
PostgreSQL et **ne lit plus ce fichier : aucun outil de reprise des données
n'est fourni.** Une instance mise à jour démarre sur une base vide ; les
comptes, demandes et journaux d'audit de la 0.1.0 ne sont pas repris (les
dossiers `files/`, `seal/` et `instance.key` restent utilisés). Si cet
historique vous est nécessaire, conservez la 0.1.0, ou archivez son volume
`/data` tel quel, et démarrez cette version comme une nouvelle instance.

Fonctions, configuration, restauration, sceau et tests : voir la version
anglaise ci-dessus, qui fait référence.
