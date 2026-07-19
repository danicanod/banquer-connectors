/**
 * Facebank Bank Client (PR) — hybrid Playwright login + in-browser data scraping
 *
 * Facebank's online banking is a COBIS CWC Angular SPA (JWT auth, JS-rendered
 * grids). Login runs in Playwright (with an emailed OTP), and account data is
 * read from the live authenticated page.
 *
 * ```typescript
 * import { createFacebankClient } from '@danicanod/banquer-connectors/facebank';
 *
 * const client = createFacebankClient(
 *   { username: 'user', password: 'pass' },
 *   { headless: false, otpProvider: async () => '12345' }
 * );
 * await client.login();
 * const { accounts } = await client.getAccounts();
 * const { transactions } = await client.getAccountMovements();
 * await client.close();
 * ```
 */

// Main client (recommended)
export {
  FacebankClient,
  createFacebankClient,
  type FacebankClientCredentials,
  type FacebankClientConfig,
  type FacebankClientLoginResult,
} from './client.js';

// Advanced: auth + scraper (for custom flows)
export { FacebankAuth } from './auth/facebank-auth.js';
export { FacebankScraper } from './scraper/facebank-scraper.js';

// Types
export type {
  FacebankCredentials,
  FacebankAuthConfig,
  FacebankAccount,
  FacebankTransaction,
  FacebankLoginResult,
  FacebankScrapingResult,
  FacebankAccountsResult,
  FacebankMovementsResult,
} from './types/index.js';

export { FACEBANK_URLS, FACEBANK_ROUTES, FACEBANK_SELECTORS, FACEBANK_CONFIG } from './types/index.js';

// Default export
import { FacebankClient } from './client.js';
export default FacebankClient;
