/**
 * BanescoClient - Unified HTTP-first Client
 *
 * This is the recommended way to interact with Banesco online banking.
 * Uses Playwright internally for login (required due to JS/iframe/security questions),
 * then switches to HTTP for all data fetching (faster, more stable).
 * 
 * ## Login Flow
 * 
 * 1. Playwright opens Banesco login page (handles iframes)
 * 2. Enters username → detects security questions OR password page
 * 3. If security questions: matches keywords from config → fills answers
 * 4. Enters password → submits → verifies login success
 * 5. Extracts session cookies → transfers to HTTP client
 * 6. Closes Playwright → uses HTTP for all subsequent requests
 * 
 * ## Security Questions Format
 * 
 * Comma-separated keyword:answer pairs (case-insensitive matching):
 * ```
 * BANESCO_SECURITY_QUESTIONS=mascota:Firulais,madre:Maria,anime:Naruto
 * ```
 * 
 * Keywords are matched against question text. Minimum 2 answers required.
 * If login fails with "no_keyword_match", check logs for actual question text.
 *
 * @example
 * ```typescript
 * import { createBanescoClient } from '@danicanod/banquer-connectors';
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
 * 
 * @see {@link BanescoAuth} - Lower-level Playwright authentication
 * @see {@link BanescoHttpClient} - HTTP client for post-login operations
 */

import { BanescoAuth } from './auth/banesco-auth.js';
import {
  BanescoHttpClient,
  type BanescoHttpCredentials,
  type BanescoHttpTransaction,
  type BanescoAccountsResult,
  type BanescoMovementsResult,
} from './http/banesco-http-client.js';

// ============================================================================
// Types
// ============================================================================

export interface BanescoClientCredentials {
  username: string;
  password: string;
  securityQuestions: string;
}

export interface BanescoClientConfig {
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
  /** Request timeout in ms (default: 60000 for login, 30000 for HTTP) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /**
   * Connect to a remote browser over CDP (e.g. a Browserbase session's
   * `connectUrl`) instead of launching a local Chromium. When set, the login
   * step runs in the remote browser. Note: after login the client fetches data
   * over in-process HTTP, so the host's egress IP differs from the remote
   * browser's — verify the target bank tolerates that before relying on it.
   */
  browserWSEndpoint?: string;
}

export interface BanescoLoginResult {
  success: boolean;
  message: string;
  cookieCount?: number;
}

// ============================================================================
// BanescoClient
// ============================================================================

export class BanescoClient {
  private credentials: BanescoClientCredentials;
  // browserWSEndpoint stays genuinely optional; the rest have resolved defaults.
  private config: Required<Omit<BanescoClientConfig, 'browserWSEndpoint'>> &
    Pick<BanescoClientConfig, 'browserWSEndpoint'>;
  private httpClient: BanescoHttpClient | null = null;
  private auth: BanescoAuth | null = null;
  private isLoggedIn: boolean = false;

  constructor(credentials: BanescoClientCredentials, config: BanescoClientConfig = {}) {
    this.credentials = credentials;
    this.config = {
      headless: config.headless ?? true,
      timeout: config.timeout ?? 60000,
      debug: config.debug ?? false,
      browserWSEndpoint: config.browserWSEndpoint,
    };
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BanescoClient] ${message}`);
    }
  }

  /**
   * Login to Banesco using Playwright (handles JS, iframes, security questions),
   * then transfer session cookies to HTTP client for subsequent operations.
   */
  async login(): Promise<BanescoLoginResult> {
    this.log('Starting login flow...');

    try {
      // Step 1: Use Playwright for authentication
      this.auth = new BanescoAuth(this.credentials, {
        headless: this.config.headless,
        timeout: this.config.timeout,
        browserWSEndpoint: this.config.browserWSEndpoint,
      });

      const loginResult = await this.auth.login();

      if (!loginResult.success) {
        return {
          success: false,
          message: loginResult.message || 'Login failed',
        };
      }

      // Step 2: Extract cookies from Playwright session
      const page = this.auth.getPage();
      if (!page) {
        throw new Error('No page available after login');
      }

      // Navigate to movements page directly in Playwright to establish session state
      // This ensures all cookies are set before we switch to HTTP client
      this.log('Navigating to movements page in Playwright...');
      try {
        await page.goto('https://www.banesconline.com/Mantis/WebSite/ConsultaMovimientosCuenta/MovimientosCuenta.aspx', {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        await page.waitForTimeout(2000);
        this.log('   Loaded movements page');
      } catch (e) {
        this.log(`   Movements page navigation failed: ${e instanceof Error ? e.message : e}`);
      }

      // Get ALL cookies from context (includes all domains/paths)
      const playwrightCookies = await page.context().cookies();
      this.log(`Extracted ${playwrightCookies.length} cookies from Playwright`);
      
      // Debug: log each cookie's domain and name
      for (const cookie of playwrightCookies) {
        this.log(`   Cookie: ${cookie.name} (domain: ${cookie.domain}, path: ${cookie.path})`);
      }

      // Step 3: Create HTTP client with extracted cookies
      const httpCredentials: BanescoHttpCredentials = {
        username: this.credentials.username,
        password: this.credentials.password,
        securityQuestions: this.credentials.securityQuestions,
      };

      this.httpClient = new BanescoHttpClient(httpCredentials, {
        timeout: 30000,
        debug: this.config.debug,
        skipLogin: true,
      });

      // Import cookies from Playwright
      this.httpClient.importCookiesFromPlaywright(playwrightCookies);

      // Step 4: Close Playwright (no longer needed)
      await this.auth.close();
      this.auth = null;

      this.isLoggedIn = true;
      this.log('Login successful, switched to HTTP client');

      return {
        success: true,
        message: 'Login successful',
        cookieCount: playwrightCookies.length,
      };
    } catch (error: unknown) {
      // Cleanup on error
      if (this.auth) {
        await this.auth.close();
        this.auth = null;
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: message || 'Unknown login error',
      };
    }
  }

  /**
   * Get list of accounts
   */
  async getAccounts(): Promise<BanescoAccountsResult> {
    if (!this.httpClient || !this.isLoggedIn) {
      return {
        success: false,
        message: 'Not logged in. Call login() first.',
        accounts: [],
      };
    }

    return this.httpClient.getAccounts();
  }

  /**
   * Get movements/transactions for a specific account
   */
  async getAccountMovements(accountNumber: string): Promise<BanescoMovementsResult> {
    if (!this.httpClient || !this.isLoggedIn) {
      return {
        success: false,
        message: 'Not logged in. Call login() first.',
        accountNumber,
        transactions: [],
      };
    }

    return this.httpClient.getAccountMovements(accountNumber);
  }

  /**
   * Get transactions using the legacy method (fallback)
   */
  async getTransactions(): Promise<{
    success: boolean;
    message: string;
    transactions: BanescoHttpTransaction[];
    error?: string;
  }> {
    if (!this.httpClient || !this.isLoggedIn) {
      return {
        success: false,
        message: 'Not logged in. Call login() first.',
        transactions: [],
      };
    }

    return this.httpClient.getTransactions();
  }

  /**
   * Check if logged in
   */
  isAuthenticated(): boolean {
    return this.isLoggedIn;
  }

  /**
   * Close client and cleanup resources
   */
  async close(): Promise<void> {
    if (this.auth) {
      await this.auth.close();
      this.auth = null;
    }
    this.httpClient = null;
    this.isLoggedIn = false;
    this.log('Client closed');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new BanescoClient instance
 */
export function createBanescoClient(
  credentials: BanescoClientCredentials,
  config?: BanescoClientConfig
): BanescoClient {
  return new BanescoClient(credentials, config);
}
