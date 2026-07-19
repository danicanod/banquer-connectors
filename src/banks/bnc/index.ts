/**
 * BNC Bank Client (HTTP-Only)
 *
 * Pure HTTP-based client for Banco Nacional de Crédito (BNC).
 * No browser automation required - uses direct HTTP requests.
 *
 * Recommended usage:
 * ```typescript
 * import { createBncClient } from '@danicanod/banquer-connectors/bnc';
 *
 * const client = createBncClient({
 *   id: 'V12345678',
 *   cardNumber: '1234567890123456',
 *   password: 'your_password'
 * });
 *
 * await client.login();
 * const transactions = await client.getTransactions();
 * await client.close();
 * ```
 */

// Main client (recommended)
export {
  BncClient,
  createBncClient,
  type BncClientCredentials,
  type BncClientConfig,
  type BncLoginResult as BncClientLoginResult,
} from './client.js';

// Advanced: HTTP Client (direct access)
export {
  BncHttpClient,
  createBncHttpClient,
  quickHttpLogin,
  quickHttpScrape,
} from './http/index.js';
export type { BncHttpConfig, BncHttpLoginResult } from './http/index.js';

// Types and constants
export type {
  BncCredentials,
  BncLoginResult,
  BncAuthConfig,
  BncAccount,
  BncTransaction,
} from './types/index.js';

export {
  BNC_URLS,
  BNC_SELECTORS,
  BNC_CONFIG,
} from './types/index.js';

export type {
  BncScrapingResult,
} from './types/index.js';

// Default export
import { BncClient } from './client.js';
export default BncClient;
