# Architecture

This document describes the module structure and dependency rules for the banquer-connectors library.

## Module Layout

```
src/
├── core/           # Bank-agnostic domain (transactions, types)
├── shared/         # Shared utilities (HTTP client, base auth, performance)
├── banks/          # Bank-specific implementations
│   ├── banesco/    # Hybrid: Playwright login + HTTP fetch
│   ├── bnc/        # Pure HTTP
│   └── facebank/   # Playwright login (+ emailed OTP) + in-browser scraping
├── dev/            # Development utilities (not published)
└── index.ts        # Public API entrypoint
```

## Dependency Rules

```
┌─────────────┐
│   banks/*   │ ──────────────────────────────┐
└──────┬──────┘                               │
       │ imports                              │ imports
       ▼                                      ▼
┌─────────────┐                        ┌─────────────┐
│    core     │                        │   shared    │
└─────────────┘                        └─────────────┘
```

### core/
- Bank-agnostic domain models and normalization
- **MUST NOT** import from `banks/*`

### shared/
- Shared utilities (HTTP clients, base auth class, performance config)
- **MUST NOT** import from `banks/*`

### banks/<bank>/
- Bank-specific authentication and scraping logic
- **MAY** import from `core/*` and `shared/*`
- **MUST NOT** import from other banks

## Public API

The library exposes:

1. **Main entrypoint** (`@danicanod/banquer-connectors`)
   - `createBanescoClient`, `createBncClient`, `createFacebankClient` - Client factories
   - `normalizeTransactions`, `makeTxnKey` - Transaction utilities

2. **Bank-specific entrypoints** (`@danicanod/banquer-connectors/banesco`, `.../bnc`, `.../facebank`)
   - Advanced APIs for custom flows

3. **Core utilities** (`@danicanod/banquer-connectors/core`)
   - Transaction normalization and types only (no bank dependencies)

## Adding a New Bank

1. Create `src/banks/<bank>/` with:
   - `client.ts` - Main client facade
   - `types/index.ts` - Bank-specific types
   - `http/` or `auth/` - Implementation details

2. Use `core/transactions` for normalization

3. Export from `src/index.ts` and add to `package.json` exports
