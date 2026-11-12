# Contributing to SignSen

Thank you for helping. SignSen is a self-hostable, open-source (Apache-2.0)
electronic signature application. These rules apply to every contribution,
whether written by hand or with the help of a tool.

## Ground rules

- **The spec comes first.** `docs/SPEC.md` is the functional contract the tests
  are written against: update it before changing behaviour.
- **Clean room.** Build from standard e-signature features only. Never import
  code, selectors, wording, API shapes or data from another vendor's product, and
  never name a trust service provider in the code, UI, tests or docs.
- **Honest legal level.** SignSen produces simple electronic signatures backed by
  an evidence file and a PKCS#7 seal. Never describe it as qualified, and never
  advertise a feature (PAdES baseline, RFC 3161 timestamps…) that is not
  implemented and tested.
- **The audit trail is sacred.** `events` is append-only and hash-chained; never
  bypass `appendEvent()` and never weaken the database triggers or the
  `events_chain_unique` constraint.
- **One writer per envelope.** PostgreSQL serves many connections at once: a
  transaction that changes an envelope takes its lock first (`lockEnvelope()` in
  `src/server/db/locks.ts`), then reads what it is about to check. Every new
  "read, check, write" needs a test that runs it concurrently.

## Architecture

- Domain logic lives in `src/server/*`: plain TypeScript, takes a `Services`
  object, unit-tested without a web server.
- Next.js (`src/app/*`) is a thin layer. Every request-time read goes through
  `services()` in `src/server/request.ts` (it calls `connection()`: the
  database belongs to the running instance, never to the build) and renders
  under `<Suspense>` (Cache Components). Everything that touches the database
  is `async`: await it — a forgotten `await` on a write is a silent bug.
  Next.js 16 differs from older versions: read the guides in
  `node_modules/next/dist/docs/` before changing framework code (see
  `AGENTS.md`).
- `src/proxy.ts` answers real 404s before rendering; pages keep their own checks.

## Tests

Both suites need a PostgreSQL server, given by `TEST_DATABASE_URL`: a connection
to any database of that server with a role allowed to create databases. For
example, with a throwaway container:

```bash
docker run -d --name signsen-test-db -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18.6-alpine3.24
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres

npm test             # Vitest — unit and integration, one temporary database per test
npm run test:e2e     # Playwright — production build, database recreated for the run, real outbox
```

Each unit test gets its own migrated database (`signsen_test_*`, dropped when
the test ends; leftovers of a crashed run are dropped at the end of the run).
The end-to-end run drops and recreates `signsen_e2e_<port>`. Schema changes go
through `npm run db:generate` (drizzle-kit, PostgreSQL dialect); triggers and
other hand-written SQL go in a `drizzle-kit generate --custom` migration.

End-to-end tests use page objects (`e2e/pages`), flows (`e2e/flows`), fixtures
(`e2e/fixtures`) and synthetic data (`e2e/support`, `@e2e.test` addresses).
Select elements by role and accessible label, not by CSS class: an ambiguous
selector usually reveals a real accessibility problem — fix the UI.

For a security rule, prove the test protects it: break the code on purpose,
watch the test fail, restore.

## Before opening a pull request

```bash
npm run typecheck
npx eslint src e2e
npm test
npm run test:e2e
```

Check that no runtime data is staged (`data/`, `e2e/.data/`, `*.p12`, `.env*`),
keep commits focused, and describe what you verified.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
