# Contributing to Banquer Connectors

Thanks for your interest in contributing! This library connects to Venezuelan
bank accounts (Banesco, BNC) from TypeScript.

## Getting started

```bash
pnpm install
pnpm run type-check
pnpm run lint
pnpm run build
```

> Prerequisites: Node.js >= 18, pnpm >= 8. Playwright's Chromium is installed via
> `postinstall` (required for Banesco login). To skip it during development, run
> `pnpm install --ignore-scripts`.

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

To add a new bank, create `src/banks/<bank>/` with a client facade + types, reuse
`core/transactions` for normalization, and export it from `src/index.ts` and the
`package.json` `exports` map.

## Code style

- TypeScript strict mode, ESLint enforced.
- Logging: `[Component] action (optional data)` — no emojis in library logs.
- Prefer `unknown` over `any`; prefix unused params with `_`.

## Security

Never commit `.env` files or credentials. For vulnerabilities, see
[`SECURITY.md`](SECURITY.md) — please email rather than opening a public issue.
