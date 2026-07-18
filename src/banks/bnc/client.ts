/**
 * BncClient - Unified HTTP Client
 *
 * This is the recommended way to interact with BNC online banking.
 * Uses pure HTTP requests (no browser needed). ~8-10x faster than browser-based scrapers.
 * 
 * ## Login Flow
 * 
 * 1. (Optional) Logout to clear any existing session
 * 2. GET `/` → Extract `__RequestVerificationToken`
 * 3. POST `/Auth/PreLogin_Try` → Card number + User ID
 * 4. POST `/Auth/Login_Try` → Password
 * 5. GET `/Home/BNCNETHB/Welcome` → Verify success
 * 
 * ## Limitations
 * 
 * - **Last 25 transactions only** - BNC API does not expose full history
 * - **Accounts are discovered dynamically** at login (BNC exposes a fixed set per user)
 * - Session can expire; use `logoutFirst: true` to avoid "session already active" errors
 * 
 * ## Transaction IDs
 * 
 * Each transaction gets a deterministic ID: `bnc-${sha256(date+amount+ref+desc+type+account).slice(0,16)}`
 * This enables idempotent ingestion to Convex.
 *
 * @example
 * ```typescript
 * import { createBncClient } from '@danicanod/banquer-connectors';
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
 * 
 * @see {@link BncHttpClient} - Lower-level HTTP client
 * @see {@link quickHttpScrape} - One-liner for login + fetch
 */

import { BncHttpClient } from './http/bnc-http-client.js';
import type { BncCredentials, BncScrapingResult } from './types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface BncClientCredentials {
  id: string;
  cardNumber: string;
  password: string;
}

export interface BncClientConfig {
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Attempt logout before login to clear existing session (default: true) */
  logoutFirst?: boolean;
}

export interface BncLoginResult {
  success: boolean;
  message: string;
}

// ============================================================================
// BncClient
// ============================================================================

export class BncClient {
  private config: Required<BncClientConfig>;
  private httpClient: BncHttpClient;
  private isLoggedIn: boolean = false;

  constructor(credentials: BncClientCredentials, config: BncClientConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      logoutFirst: config.logoutFirst ?? true,
    };

    const bncCredentials: BncCredentials = {
      id: credentials.id,
      card: credentials.cardNumber,
      password: credentials.password,
    };

    this.httpClient = new BncHttpClient(bncCredentials, {
      timeout: this.config.timeout,
      debug: this.config.debug,
      logoutFirst: this.config.logoutFirst,
    });
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BncClient] ${message}`);
    }
  }

  /**
   * Login to BNC using HTTP
   */
  async login(): Promise<BncLoginResult> {
    this.log('Starting login flow...');

    try {
      const result = await this.httpClient.login();

      if (result.success) {
        this.isLoggedIn = true;
        this.log('Login successful');
      }

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: message || 'Unknown login error',
      };
    }
  }

  /**
   * Get transactions (last 25)
   */
  async getTransactions(): Promise<BncScrapingResult> {
    if (!this.isLoggedIn) {
      return {
        success: false,
        message: 'Not logged in. Call login() first.',
        data: [],
        bankName: 'BNC',
        timestamp: new Date(),
      };
    }

    return this.httpClient.fetchLast25Transactions();
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
    // BNC HTTP client doesn't need explicit cleanup
    this.isLoggedIn = false;
    this.log('Client closed');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new BncClient instance
 */
export function createBncClient(
  credentials: BncClientCredentials,
  config?: BncClientConfig
): BncClient {
  return new BncClient(credentials, config);
}
