/**
 * Banesco Bank Client
 *
 * Hybrid client for Banco Universal Banesco:
 * - Playwright-based authentication (handles JS, iframes, security questions)
 * - HTTP-based data fetching (faster, more stable after login)
 *
 * Recommended usage:
 * ```typescript
 * import { createBanescoClient } from '@danicanod/banquer-connectors/banesco';
 *
 * const client = createBanescoClient({
 *   username: 'V12345678',
 *   password: 'your_password',
 *   securityQuestions: 'keyword1:answer1,keyword2:answer2'
 * });
 *
 * await client.login();
 * const accounts = await client.getAccounts();
 * const movements = await client.getAccountMovements(accounts[0].accountNumber);
 * await client.close();
 * ```
 */

// Main client (recommended)
export {
  BanescoClient,
  createBanescoClient,
  type BanescoClientCredentials,
  type BanescoClientConfig,
  type BanescoLoginResult,
} from './client.js';

// Advanced: Auth (Playwright-based, for custom flows)
export { BanescoAuth, type BanescoErrorDetails } from './auth/banesco-auth.js';
export { SecurityQuestionsHandler } from './auth/security-questions.js';

// Advanced: HTTP Client (for custom flows after auth)
export {
  BanescoHttpClient,
  createBanescoHttpClient,
  type BanescoHttpCredentials,
  type BanescoHttpConfig,
  type BanescoHttpLoginResult,
  type BanescoHttpTransaction,
  type BanescoHttpScrapingResult,
  type BanescoAccountsResult,
  type BanescoMovementsResult,
} from './http/index.js';

// Types and constants
export type {
  BanescoCredentials,
  BanescoAuthConfig,
  BanescoAccount,
  BanescoTransaction,
  Account,
  Transaction,
  LoginResult,
  BrowserConfig,
} from './types/index.js';

export {
  BANESCO_URLS,
  BANESCO_CONFIG,
} from './types/index.js';

// Default export
import { BanescoClient } from './client.js';
export default BanescoClient;
