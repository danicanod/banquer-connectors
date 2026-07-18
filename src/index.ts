/**
 * Banquer Connectors - Venezuelan & PR bank connectors (Banesco, BNC, Facebank)
 *
 * A TypeScript library for connecting to bank accounts.
 * Supports Banesco (hybrid: Playwright login + HTTP fetch), BNC (pure HTTP),
 * and Facebank PR (Playwright login + emailed OTP + in-browser scraping).
 *
 * @example
 * ```typescript
 * import { createBanescoClient, createBncClient } from '@danicanod/banquer-connectors';
 *
 * // Banesco usage (hybrid mode - Playwright for login, HTTP for data)
 * const banesco = createBanescoClient({
 *   username: 'V12345678',
 *   password: 'your_password',
 *   securityQuestions: 'keyword1:answer1,keyword2:answer2'
 * });
 * await banesco.login();
 * const accounts = await banesco.getAccounts();
 * await banesco.close();
 *
 * // BNC usage (pure HTTP - no browser needed)
 * const bnc = createBncClient({
 *   id: 'V12345678',
 *   cardNumber: '1234567890123456',
 *   password: 'your_password'
 * });
 * await bnc.login();
 * const transactions = await bnc.getTransactions();
 * await bnc.close();
 * ```
 */

// ============================================================================
// Banesco Bank Exports (Hybrid: Playwright login + HTTP data fetch)
// ============================================================================

// Main client (recommended)
export {
  BanescoClient,
  createBanescoClient,
  type BanescoClientCredentials,
  type BanescoClientConfig,
  type BanescoLoginResult,
} from './banks/banesco/client.js';

// Advanced: Auth (Playwright-based, for custom flows)
export { BanescoAuth } from './banks/banesco/auth/banesco-auth.js';
export { SecurityQuestionsHandler } from './banks/banesco/auth/security-questions.js';

// Advanced: HTTP Client (for custom flows after auth)
export {
  BanescoHttpClient,
  createBanescoHttpClient,
} from './banks/banesco/http/index.js';

export type {
  BanescoHttpCredentials,
  BanescoHttpConfig,
  BanescoHttpTransaction,
  BanescoAccountsResult,
  BanescoMovementsResult,
} from './banks/banesco/http/index.js';

// Types
export type {
  BanescoCredentials,
  BanescoAuthConfig,
  BanescoAccount,
  BanescoTransaction,
} from './banks/banesco/types/index.js';

export {
  BANESCO_URLS,
  BANESCO_CONFIG,
} from './banks/banesco/types/index.js';

// ============================================================================
// BNC Bank Exports (Pure HTTP - no browser needed)
// ============================================================================

// Main client (recommended)
export {
  BncClient,
  createBncClient,
  type BncClientCredentials,
  type BncClientConfig,
  type BncLoginResult as BncClientLoginResult,
} from './banks/bnc/client.js';

// Advanced: HTTP Client (direct access)
export {
  BncHttpClient,
  createBncHttpClient,
  quickHttpLogin,
  quickHttpScrape,
} from './banks/bnc/http/index.js';

export type {
  BncHttpConfig,
  BncHttpLoginResult,
} from './banks/bnc/http/index.js';

// Types
export type {
  BncCredentials,
  BncLoginResult,
  BncAuthConfig,
  BncScrapingResult,
  BncAccount,
  BncTransaction,
} from './banks/bnc/types/index.js';

export {
  BNC_URLS,
  BNC_SELECTORS,
  BNC_CONFIG,
} from './banks/bnc/types/index.js';

// ============================================================================
// Facebank Bank Exports (PR) — Playwright login + in-browser data scraping
// ============================================================================

// Main client (recommended)
export {
  FacebankClient,
  createFacebankClient,
  type FacebankClientCredentials,
  type FacebankClientConfig,
  type FacebankClientLoginResult,
} from './banks/facebank/client.js';

// Advanced: auth + scraper (for custom flows)
export { FacebankAuth } from './banks/facebank/auth/facebank-auth.js';
export { FacebankScraper } from './banks/facebank/scraper/facebank-scraper.js';

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
} from './banks/facebank/types/index.js';

export {
  FACEBANK_URLS,
  FACEBANK_ROUTES,
  FACEBANK_SELECTORS,
  FACEBANK_CONFIG,
} from './banks/facebank/types/index.js';

// ============================================================================
// Shared Infrastructure Exports (Advanced)
// ============================================================================

export { BaseBankAuth } from './shared/base-bank-auth.js';

export type {
  BaseBankAuthConfig,
  BaseBankLoginResult,
  BaseBankCredentials,
} from './shared/types/index.js';

export {
  PERFORMANCE_PRESETS,
  type PerformanceConfig,
} from './shared/performance-config.js';

// Interactive input helper (e.g. OTP prompt fallback for CLI flows)
export { promptForInput } from './shared/utils/interactive.js';

// ============================================================================
// Unified Transaction Model Exports (from core/)
// ============================================================================

export {
  makeTxnKey,
  normalizeTransaction,
  normalizeTransactions,
} from './core/index.js';

export type {
  Transaction,
  TxnKeyInput,
  BankCode,
  TransactionType,
  BankTransactionInput,
  NormalizeOptions,
  Account,
} from './core/index.js';
