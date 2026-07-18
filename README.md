# Banquer Connectors

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

**TypeScript library for connecting to Venezuelan bank accounts**

[Installation](#installation) • [Quick Start](#quick-start) • [API Reference](#api-reference) • [Normalized Output](#normalized-output)

</div>

---

## Supported Banks

| Bank | Mode | Authentication | Transactions | Speed |
|------|------|---------------|--------------|-------|
| **Banesco** | Hybrid (Playwright login + HTTP fetch) | Username + Password + Security Questions | Full history | Fast after login |
| **BNC** | Pure HTTP (no browser) | Card + ID + Password | Last 25 transactions | ~8-10x faster |
| **Facebank** (PR) | Browser-driven (Playwright login + in-browser scraping) | Username + Password + emailed OTP | Recent movements | Browser-bound |

## Installation

```bash
npm install @danicanod/banquer-connectors
```

### Prerequisites

- Node.js >= 18
- npm >= 8

Playwright Chromium is installed automatically via postinstall (required for Banesco login).

## Quick Start

### Banesco (Hybrid Mode)

```typescript
import { createBanescoClient, normalizeTransactions } from '@danicanod/banquer-connectors';

const client = createBanescoClient({
  username: 'V12345678',
  password: 'your_password',
  securityQuestions: 'anime:Naruto,mascota:Firulais'
});

await client.login();

const accounts = await client.getAccounts();
const movements = await client.getAccountMovements(accounts.accounts[0].accountNumber);

// Normalize transactions to unified format
const normalized = normalizeTransactions('banesco', movements.transactions);

await client.close();
```

### BNC (Pure HTTP - No Browser)

```typescript
import { createBncClient, normalizeTransactions } from '@danicanod/banquer-connectors';

const client = createBncClient({
  id: 'V12345678',
  cardNumber: '1234567890123456',
  password: 'your_password'
});

await client.login();

const result = await client.getTransactions();
const normalized = normalizeTransactions('bnc', result.data ?? []);

await client.close();
```

### Facebank (Browser-driven + emailed OTP)

Facebank (PR) is a COBIS/Angular SPA: login runs in Playwright and a 5-character
one-time code is emailed at login. Supply it with an `otpProvider` callback, or
omit it to be prompted on the terminal. The session stays open while data is
scraped from the live page, so call `close()` when done.

```typescript
import { createFacebankClient, normalizeTransactions } from '@danicanod/banquer-connectors';

const client = createFacebankClient(
  { username: 'your_username', password: 'your_password' },
  { headless: false, otpProvider: async () => '12345' } // omit otpProvider to prompt on stdin
);

await client.login();

const accounts = await client.getAccounts();
const movements = await client.getAccountMovements();
const normalized = normalizeTransactions('facebank', movements.transactions);

await client.close();
```

## API Reference

### BanescoClient

```typescript
import { createBanescoClient } from '@danicanod/banquer-connectors';

const client = createBanescoClient(credentials, config);

await client.login();
const accounts = await client.getAccounts();
const movements = await client.getAccountMovements(accountNumber);
await client.close();
```

### BncClient

```typescript
import { createBncClient } from '@danicanod/banquer-connectors';

const client = createBncClient(credentials, config);

await client.login();
const result = await client.getTransactions();
await client.close();
```

### FacebankClient

```typescript
import { createFacebankClient } from '@danicanod/banquer-connectors';

const client = createFacebankClient(credentials, config);

await client.login();                        // Playwright login + emailed OTP
const accounts = await client.getAccounts();
const movements = await client.getAccountMovements();
await client.close();                        // closes the browser session
```

## Normalized Output

Unified `Transaction` type for consistent data across all banks:

```typescript
interface Transaction {
  bank: 'banesco' | 'bnc' | 'facebank';
  txnKey: string;      // Deterministic hash for idempotent storage
  date: string;        // YYYY-MM-DD
  amount: number;      // Always positive
  description: string;
  type: 'debit' | 'credit';
  reference?: string;
  accountId?: string;
  raw?: unknown;
}
```

### Normalization API

```typescript
import { normalizeTransactions, makeTxnKey } from '@danicanod/banquer-connectors';

// Normalize transactions
const normalized = normalizeTransactions('banesco', transactions);

// Generate deterministic key
const key = makeTxnKey('banesco', { date, amount, description, type });
```

## Configuration

```typescript
// Banesco
interface BanescoClientConfig {
  headless?: boolean;          // Default: true
  timeout?: number;            // Default: 60000ms
  debug?: boolean;             // Default: false
  browserWSEndpoint?: string;  // Optional: attach to a remote browser over CDP
}

// BNC
interface BncClientConfig {
  timeout?: number;     // Default: 30000ms
  debug?: boolean;      // Default: false
}

// Facebank
interface FacebankClientConfig {
  headless?: boolean;                     // Default: false
  timeout?: number;                       // Default: 45000ms
  debug?: boolean;                        // Default: false
  browserWSEndpoint?: string;             // Optional: remote browser over CDP
  otpProvider?: () => Promise<string>;    // Supplies the emailed OTP; omit to prompt on stdin
  manualImageFallback?: boolean;          // Default: true (pause for the rare image step-up)
}
```

### Remote browser (CDP)

By default Banesco login launches a local Chromium. To run the login step in a
**remote browser** instead — e.g. a [Browserbase](https://browserbase.com)
session on a server that can't launch Chromium — pass its CDP `connectUrl` as
`browserWSEndpoint`:

```typescript
import { createBanescoClient } from '@danicanod/banquer-connectors';

const client = createBanescoClient(credentials, {
  browserWSEndpoint: session.connectUrl, // e.g. from Browserbase
});
await client.login();
```

> Note: login runs in the remote browser, but data is then fetched over
> in-process HTTP, so the host's egress IP differs from the remote browser's.
> Verify the bank tolerates that before relying on it in production. BNC is pure
> HTTP and never uses a browser.

## Environment Variables

```bash
# Banesco
BANESCO_USERNAME=V12345678
BANESCO_PASSWORD=your_password
BANESCO_SECURITY_QUESTIONS=anime:Naruto,mascota:Firulais

# BNC
BNC_ID=V12345678
BNC_CARD=1234567890123456
BNC_PASSWORD=your_password

# Facebank (PR)
FACEBANK_USERNAME=your_username
FACEBANK_PASSWORD=your_password
# Optional — only if the security-image step-up appears:
# FACEBANK_SECRET_WORD=your_image_alias
# FACEBANK_SECRET_IMAGE=your_image_id
```

## Development

```bash
npm install
npm run type-check
npm run lint
npm run build
```

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run type-check` and `npm run lint` before committing
3. Keep PRs focused on a single feature or fix
4. Update docs if changing the public API

## Security

- **Never commit** `.env` files or credentials
- Store secrets in environment variables
- Session data stored in `.sessions/` (gitignored, 24h expiry)
- All bank connections use HTTPS
- For vulnerabilities, email danicanod@gmail.com (not public issues)

## Code Style

- TypeScript strict mode, ESLint enforced
- Logging: `[Component] action (optional data)` — no emojis
- Prefer `unknown` over `any`; prefix unused params with `_`

## License

MIT License - see [LICENSE](LICENSE) for details.
