# Contributing to Banquer Connectors

Thanks for your interest in contributing! This library connects to Venezuelan
and Puerto Rican bank accounts (Banesco, BNC & Facebank) from TypeScript.

## Getting started

```bash
pnpm install
pnpm run type-check
pnpm run lint
pnpm run build
```

> Prerequisites: Node.js >= 18, pnpm >= 8. The browser-driven banks (Banesco,
> Facebank) need Playwright's Chromium, which is **not** installed automatically.
> Install it once with `pnpm run install:browser` (or `npx playwright install
> chromium`). BNC is pure HTTP and needs no browser.

## Workflow

1. Fork the repo and create a feature branch.
2. Make your change. Keep PRs focused on a single feature or fix.
3. Run `pnpm run type-check` and `pnpm run lint` before committing — CI runs both.
4. Update the docs (`README.md`, `ARCHITECTURE.md`) if you change the public API.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the module layout and dependency
rules. In short:

- `core/` — bank-agnostic domain (transactions, normalization). Must not import
  from `banks/*`.
- `shared/` — HTTP client, base auth class, performance config. Must not import
  from `banks/*`.
- `banks/<bank>/` — bank-specific auth + scraping. May import `core/*` and
  `shared/*`, never another bank.

To add a new bank, create `src/banks/<bank>/` with a client facade + types that
returns the bank's own result shape, and export it from `src/index.ts` and the
`package.json` `exports` map. Normalization to the canonical `Transaction` model
is **caller-side**: expose your raw rows and let consumers call
`normalizeTransactions('<bank>', rows)` from `core/` (the clients don't normalize
for you).

## Code style

- TypeScript strict mode, ESLint enforced.
- Logging: `[Component] action (optional data)` — no emojis in library logs.
- Prefer `unknown` over `any`; prefix unused params with `_`.

## Security

Never commit `.env` files or credentials. For vulnerabilities, see
[`SECURITY.md`](SECURITY.md) — please email rather than opening a public issue.
