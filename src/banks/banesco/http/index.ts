/**
 * Banesco HTTP Client Module
 * 
 * HTTP-based Banesco client for fast data fetching (accounts, movements).
 * 
 * IMPORTANT: This client requires authentication cookies from Playwright.
 * Pure HTTP login is NOT supported for Banesco due to JavaScript-based
 * session establishment. Use the hybrid approach:
 * 
 * 1. Login with Playwright (BanescoAuth)
 * 2. Export cookies from Playwright context
 * 3. Import cookies to BanescoHttpClient
 * 4. Use HTTP client for fast data fetching (~10x faster than Playwright)
 * 
 * See: npm run example:banesco-hybrid
 */

// Main client
export {
  BanescoHttpClient,
  createBanescoHttpClient,
  type BanescoHttpCredentials,
  type BanescoHttpConfig,
  type BanescoHttpTransaction,
  type BanescoHttpScrapingResult,
  type BanescoAccount,
  type BanescoAccountsResult,
  type BanescoMovementsResult
} from './banesco-http-client.js';

// Form parsing utilities
export {
  parseLoginPage,
  parseSecurityQuestionsPage,
  parsePasswordPage,
  parseDashboardPage,
  parseTransactionsTable,
  parseAspNetFormFields,
  parseAllHiddenFields,
  parseCookies,
  serializeCookies,
  buildHuella,
  // Postback discovery for WebForms navigation
  parsePostBackActions,
  findBestTransactionPostBack,
  buildPostBackFormData,
  type AspNetFormFields,
  type SecurityQuestion,
  type ParsedLoginPage,
  type ParsedSecurityQuestionsPage,
  type ParsedPasswordPage,
  type PostBackAction
} from './form-parser.js';
