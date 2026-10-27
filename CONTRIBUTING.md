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
  bypass `appendEvent()` and never weaken the database triggers.

## Architecture

- Domain logic lives in `src/server/*`: plain TypeScript, takes a `Services`
  object, unit-tested without a web server.
- Next.js (`src/app/*`) is a thin layer. Every request-time read goes through
  `services()` in `src/server/request.ts` (it calls `connection()`, because
  better-sqlite3 is synchronous) and renders under `<Suspense>` (Cache
  Components). Next.js 16 differs from older versions: read the guides in
  `node_modules/next/dist/docs/` before changing framework code (see
  `AGENTS.md`).
- `src/proxy.ts` answers real 404s before rendering; pages keep their own checks.

## Tests

```bash
npm test             # Vitest — unit and integration, temporary database per test
npm run test:e2e     # Playwright — production build, fresh database, real outbox
```

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
