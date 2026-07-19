/**
 * FacebankClient - Unified client for Facebank (PR) online banking.
 *
 * Facebank is a COBIS CWC Angular SPA with JWT-based auth and JS-rendered data
 * grids, so — unlike Banesco (login-then-HTTP) — this client keeps the
 * Playwright session open after login and scrapes account data from the live
 * page.
 *
 * ## Login flow
 * 1. Playwright opens the login page and submits username + password.
 * 2. Facebank emails a 5-character OTP; it is supplied via `otpProvider`
 *    (or an interactive terminal prompt when that is omitted).
 * 3. The (rare) security-image step-up screen is handled defensively.
 * 4. On success the authenticated page is reused for all data reads.
 *
 * @example
 * ```typescript
 * import { createFacebankClient } from '@danicanod/banquer-connectors';
 *
 * const client = createFacebankClient(
 *   { username: 'user', password: 'pass' },
 *   { headless: false, otpProvider: async () => readCodeFromSomewhere() }
 * );
 * await client.login();
 * const { accounts } = await client.getAccounts();
 * const { transactions } = await client.getAccountMovements();
 * await client.close();
 * ```
 *
 * @see {@link FacebankAuth} - Lower-level Playwright authentication
 * @see {@link FacebankScraper} - In-browser data extraction
 */

import { FacebankAuth } from './auth/facebank-auth.js';
import { FacebankScraper } from './scraper/facebank-scraper.js';
import type { FacebankAccountsResult, FacebankMovementsResult } from './types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface FacebankClientCredentials {
  username: string;
  password: string;
  /** Secret word/alias tied to your security image (only if the image step-up appears). */
  secretWord?: string;
  /** Identifier of your registered security image (only if the image step-up appears). */
  secretImage?: string | number;
}

export interface FacebankClientConfig {
  /** Run browser in headless mode (default: false — interactive OTP is easier headed). */
  headless?: boolean;
  /** Login timeout in ms (default: 45000). */
  timeout?: number;
  /** Enable debug logging (default: false). */
  debug?: boolean;
  /**
   * Connect to a remote browser over CDP (e.g. a Browserbase `connectUrl`)
   * instead of launching a local Chromium. Note: interactive stdin OTP and the
   * manual image fallback assume a local, headed session.
   */
  browserWSEndpoint?: string;
  /**
   * Supplies the emailed one-time 2FA code. If omitted, the client prompts for
   * it on the terminal (stdin) — which requires an interactive TTY.
   */
  otpProvider?: () => Promise<string>;
  /**
   * Manual OTP mode (headed sessions): wait for the user to type the emailed
   * code directly in the browser instead of prompting/injecting it. Ignored
   * when `otpProvider` is set. Default: false.
   */
  manualOtp?: boolean;
  /**
   * If the security-image screen appears in a headed session, pause for the
   * user to complete it manually rather than failing (default: true).
   */
  manualImageFallback?: boolean;
}

export interface FacebankClientLoginResult {
  success: boolean;
  message: string;
  /** Whether the security-image step-up screen was encountered. */
  imageChallengeSeen?: boolean;
}

// ============================================================================
// FacebankClient
// ============================================================================

export class FacebankClient {
  private credentials: FacebankClientCredentials;
  private config: Required<Omit<FacebankClientConfig, 'browserWSEndpoint' | 'otpProvider'>> &
    Pick<FacebankClientConfig, 'browserWSEndpoint' | 'otpProvider'>;
  private auth: FacebankAuth | null = null;
  private scraper: FacebankScraper | null = null;
  private loggedIn = false;

  constructor(credentials: FacebankClientCredentials, config: FacebankClientConfig = {}) {
    this.credentials = credentials;
    this.config = {
      headless: config.headless ?? false,
      timeout: config.timeout ?? 45000,
      debug: config.debug ?? false,
      manualOtp: config.manualOtp ?? false,
      manualImageFallback: config.manualImageFallback ?? true,
      browserWSEndpoint: config.browserWSEndpoint,
      otpProvider: config.otpProvider,
    };
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[FacebankClient] ${message}`);
    }
  }

  /**
   * Authenticate with Facebank. Keeps the browser session open for subsequent
   * data reads (call {@link close} when done).
   */
  async login(): Promise<FacebankClientLoginResult> {
    this.log('Starting login flow...');
    try {
      this.auth = new FacebankAuth(this.credentials, {
        headless: this.config.headless,
        timeout: this.config.timeout,
        debug: this.config.debug,
        browserWSEndpoint: this.config.browserWSEndpoint,
        otpProvider: this.config.otpProvider,
        manualOtp: this.config.manualOtp,
        manualImageFallback: this.config.manualImageFallback,
      });

      const result = await this.auth.login();
      if (!result.success) {
        await this.close();
        return { success: false, message: result.message || 'Login failed' };
      }

      const page = this.auth.getPage();
      if (!page) {
        await this.close();
        return { success: false, message: 'No authenticated page available after login' };
      }

      this.scraper = new FacebankScraper(page, (m) => this.log(m));
      this.loggedIn = true;
      this.log('Login successful; session ready for data reads.');

      return {
        success: true,
        message: 'Login successful',
        imageChallengeSeen: result.imageChallengeSeen,
      };
    } catch (error: unknown) {
      await this.close();
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: message || 'Unknown login error' };
    }
  }

  /** List accounts (best-effort balances; see {@link FacebankScraper.getAccounts}). */
  async getAccounts(): Promise<FacebankAccountsResult> {
    if (!this.scraper || !this.loggedIn) {
      return { success: false, message: 'Not logged in. Call login() first.', accounts: [] };
    }
    return this.scraper.getAccounts();
  }

  /** Read movements for the currently-selected account. */
  async getAccountMovements(): Promise<FacebankMovementsResult> {
    if (!this.scraper || !this.loggedIn) {
      return { success: false, message: 'Not logged in. Call login() first.', transactions: [] };
    }
    return this.scraper.getAccountMovements();
  }

  isAuthenticated(): boolean {
    return this.loggedIn;
  }

  /** Close the browser session and release resources. */
  async close(): Promise<void> {
    if (this.auth) {
      await this.auth.close();
      this.auth = null;
    }
    this.scraper = null;
    this.loggedIn = false;
    this.log('Client closed.');
  }
}

// ============================================================================
// Factory
// ============================================================================

/** Create a new FacebankClient instance. */
export function createFacebankClient(
  credentials: FacebankClientCredentials,
  config?: FacebankClientConfig
): FacebankClient {
  return new FacebankClient(credentials, config);
}
