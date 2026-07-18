/**
 * BNC HTTP Client
 * 
 * Pure HTTP-based client for BNC online banking authentication and transaction scraping.
 * Uses cookie jar for session management and cheerio for HTML parsing.
 * 
 * Authentication flow:
 * 1. GET `/` - Load login page, extract __RequestVerificationToken
 * 2. POST `/Auth/PreLogin_Try` - Submit CardNumber + UserID
 * 3. POST `/Auth/Login_Try` - Submit UserPassword
 * 4. GET `/Home/BNCNETHB/Welcome` - Verify successful login
 * 
 * Transaction scraping:
 * - GET `/Accounts/Transactions/Last25` - Fetch and parse transaction table
 */

import * as cheerio from 'cheerio';
import { BncTransactionParser } from './transaction-parser.js';
import {
  CookieFetch, 
  createCookieFetch,
  extractRequestVerificationToken
} from '../../../shared/utils/http-client.js';
import type { BncCredentials, BncTransaction, BncScrapingResult } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface BncHttpConfig {
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Custom user agent */
  userAgent?: string;
  /** 
   * Attempt to logout before login to clear any existing session.
   * Useful when BNC reports "session already active" errors.
   * Default: true
   */
  logoutFirst?: boolean;
}

export interface BncHttpLoginResult {
  success: boolean;
  message: string;
  authenticated: boolean;
  error?: string;
}

export interface BncPreLoginResponse {
  /** Type 200 = success, other = error */
  Type: number;
  /** HTML content for the password form */
  Value?: string;
  /** Legacy fields (in case API changes) */
  Succeeded?: boolean;
  Content?: string;
  Token?: string;
  Message?: string;
}

export interface BncLoginResponse {
  /** Type 200 = success */
  Type: number;
  /** Return URL after successful login */
  Value?: string;
  /** Legacy fields */
  Succeeded?: boolean;
  ReturnUrl?: string;
  Message?: string;
}

// ============================================================================
// Constants
// ============================================================================

const BNC_HTTP_URLS = {
  BASE: 'https://personas.bncenlinea.com',
  LOGIN_PAGE: 'https://personas.bncenlinea.com/',
  PRE_LOGIN: 'https://personas.bncenlinea.com/Auth/PreLogin_Try',
  LOGIN: 'https://personas.bncenlinea.com/Auth/Login_Try',
  LOGOUT: 'https://personas.bncenlinea.com/Auth/LogOut',
  WELCOME: 'https://personas.bncenlinea.com/Home/BNCNETHB/Welcome',
  TRANSACTIONS_PAGE: 'https://personas.bncenlinea.com/Accounts/Transactions/Last25',
  // This is the AJAX endpoint that returns the actual transaction data!
  TRANSACTIONS_LIST: 'https://personas.bncenlinea.com/Accounts/Transactions/Last25_List'
};

/**
 * BNC JSON `Type` response codes (observed from the AJAX endpoints):
 * 200 = success, 300/350/500 = empty result, 505 = session expired.
 */
const BNC_RESPONSE = {
  SUCCESS: 200,
  EMPTY: [300, 350, 500],
  SESSION_EXPIRED: 505
};

/** A post-login page shorter than this many chars is treated as not-yet-authenticated. */
const MIN_AUTHENTICATED_PAGE_LENGTH = 5000;

// ============================================================================
// BNC HTTP Client
// ============================================================================

export class BncHttpClient {
  private credentials: BncCredentials;
  private config: Required<BncHttpConfig>;
  private httpClient: CookieFetch;
  private isAuthenticated: boolean = false;
  private currentToken: string | null = null;
  private readonly parser = new BncTransactionParser((m) => this.log(m));

  constructor(credentials: BncCredentials, config: BncHttpConfig = {}) {
    this.credentials = credentials;
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      userAgent: config.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      logoutFirst: config.logoutFirst ?? true
    };

    this.httpClient = createCookieFetch({
      timeout: this.config.timeout,
      debug: this.config.debug,
      userAgent: this.config.userAgent,
      acceptLanguage: 'es-VE'
    });

    this.log(`BncHttpClient initialized`);
    this.log(`   User ID: ${credentials.id.substring(0, 3)}***`);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Perform complete login flow
   */
  async login(): Promise<BncHttpLoginResult> {
    this.log('Starting BNC HTTP login...');
    const startTime = Date.now();

    try {
      // Step 0: Logout first to clear any existing session
      if (this.config.logoutFirst) {
        this.log('Step 0: Clearing any existing session...');
        await this.logout();
      }

      // Step 1: Load login page and get initial token
      this.log('Step 1: Loading login page...');
      const initialToken = await this.loadLoginPage();
      
      if (!initialToken) {
        throw new Error('Failed to extract __RequestVerificationToken from login page');
      }
      
      this.currentToken = initialToken;
      this.log(`   Got initial token (${initialToken.length} chars)`);

      // Step 2: Submit PreLogin (CardNumber + UserID)
      this.log('Step 2: Submitting PreLogin (card + user ID)...');
      const preLoginResult = await this.submitPreLogin();
      
      if (!preLoginResult.success) {
        throw new Error(preLoginResult.error || 'PreLogin failed');
      }
      
      this.log('   PreLogin successful');

      // Step 3: Submit Login (Password)
      this.log('Step 3: Submitting password...');
      const loginResult = await this.submitLogin();
      
      if (!loginResult.success) {
        throw new Error(loginResult.error || 'Login failed');
      }
      
      this.log('   Password submitted');

      // Step 4: Verify authentication
      this.log('Step 4: Verifying authentication...');
      const verified = await this.verifyAuthentication();
      
      const elapsed = Date.now() - startTime;

      if (verified) {
        this.isAuthenticated = true;
        this.log(`Login successful in ${elapsed}ms`);
        
        return {
          success: true,
          message: `Authentication successful in ${elapsed}ms`,
          authenticated: true
        };
      } else {
        return {
          success: false,
          message: 'Authentication verification failed',
          authenticated: false,
          error: 'Could not verify login - may still be on login page'
        };
      }

    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Login failed after ${elapsed}ms: ${message}`);
      
      return {
        success: false,
        message,
        authenticated: false,
        error: message
      };
    }
  }

  /**
   * Fetch Last 25 transactions for all accounts
   */
  async fetchLast25Transactions(): Promise<BncScrapingResult> {
    if (!this.isAuthenticated) {
      return {
        success: false,
        message: 'Not authenticated. Call login() first.',
        data: [],
        timestamp: new Date(),
        bankName: 'BNC',
        error: 'Not authenticated'
      };
    }

    this.log('Fetching Last25 transactions...');
    const startTime = Date.now();
    const allTransactions: BncTransaction[] = [];
    const accountsScraped: string[] = [];
    const errors: string[] = [];

    // Dynamically discover accounts from the dropdown
    const accounts = await this.discoverAccounts();
    
    if (accounts.length === 0) {
      this.log(' No accounts found in dropdown');
      return {
        success: true,
        message: 'No accounts found',
        data: [],
        timestamp: new Date(),
        bankName: 'BNC',
        accountsFound: 0,
        transactionsExtracted: 0
      };
    }

    for (const account of accounts) {
      try {
        this.log(`Fetching transactions for ${account.label}...`);
        
        const transactions = await this.fetchAccountTransactionsWithValue(account.value, account.accountId || account.label);
        
        if (transactions.length > 0) {
          allTransactions.push(...transactions);
          accountsScraped.push(account.label);
          this.log(`   Got ${transactions.length} transactions from ${account.label}`);
        } else {
          this.log(`    No transactions for ${account.label}`);
        }

      } catch (error: unknown) {
        const errorMsg = `Failed to fetch ${account.label}: ${error instanceof Error ? error.message : String(error)}`;
        this.log(`   ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    const elapsed = Date.now() - startTime;

    // If the session expired mid-scrape (BNC responds Type 505, which flips
    // isAuthenticated to false), an empty/partial result is NOT "no transactions".
    // Surface it as a failure so the caller knows to re-login instead of trusting
    // an empty success.
    if (!this.isAuthenticated) {
      this.log(' BNC session expired during scrape');
      return {
        success: false,
        message: 'BNC session expired during scrape (re-login required)',
        data: allTransactions,
        timestamp: new Date(),
        bankName: 'BNC',
        accountsFound: accountsScraped.length,
        transactionsExtracted: allTransactions.length,
        error: 'session_expired',
        metadata: {
          accountsScraped,
          errors: errors.length > 0 ? errors : undefined
        }
      };
    }

    this.log(`Fetched ${allTransactions.length} transactions from ${accountsScraped.length} accounts in ${elapsed}ms`);

    return {
      success: true,
      message: `Successfully scraped ${allTransactions.length} transactions from ${accountsScraped.length} accounts`,
      data: allTransactions,
      timestamp: new Date(),
      bankName: 'BNC',
      accountsFound: accountsScraped.length,
      transactionsExtracted: allTransactions.length,
      metadata: {
        accountsScraped,
        errors: errors.length > 0 ? errors : undefined
      }
    };
  }
  
  /**
   * Discover available accounts from the transactions page dropdown
   */
  private async discoverAccounts(): Promise<Array<{ value: string; label: string; accountId?: string }>> {
    const pageHtml = await this.httpClient.getHtml(BNC_HTTP_URLS.TRANSACTIONS_PAGE, {
      'Referer': BNC_HTTP_URLS.WELCOME
    });

    const $ = cheerio.load(pageHtml);
    const accountSelect = $('#Frm_Accounts select[name="Account"], select#Account');
    const accounts: Array<{ value: string; label: string; accountId?: string }> = [];
    
    accountSelect.find('option').each((_, el) => {
      const value = $(el).attr('value');
      const label = $(el).text().trim();
      
      if (value && value !== '0') {  // Skip the "-- Seleccione --" option
        // Try to extract account number from label (e.g., "Cuenta Corriente - 0123456789")
        const accountNumberMatch = label.match(/\b(\d{10,20})\b/);
        const accountId = accountNumberMatch ? accountNumberMatch[1] : undefined;
        
        accounts.push({ value, label, accountId });
        this.log(`   Discovered account: ${label} (accountId: ${accountId || 'N/A'})`);
      }
    });
    
    return accounts;
  }
  
  /**
   * Fetch transactions for a specific account using its dropdown value
   */
  private async fetchAccountTransactionsWithValue(accountValue: string, accountName: string): Promise<BncTransaction[]> {
    const pageHtml = await this.httpClient.getHtml(BNC_HTTP_URLS.TRANSACTIONS_PAGE, {
      'Referer': BNC_HTTP_URLS.WELCOME
    });

    const $ = cheerio.load(pageHtml);
    const token = extractRequestVerificationToken(pageHtml);
    
    const formData: Record<string, string> = {};
    
    if (token) {
      formData['__RequestVerificationToken'] = token;
    }
    
    $('#Frm_Accounts input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') || '';
      if (name && name !== '__RequestVerificationToken') {
        formData[name] = value;
      }
    });
    
    formData['Account'] = accountValue;

    try {
      const result = await this.httpClient.postForm(BNC_HTTP_URLS.TRANSACTIONS_LIST, formData, {
        'Referer': BNC_HTTP_URLS.TRANSACTIONS_PAGE,
        'Accept': '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      });
      
      try {
        const jsonResponse = JSON.parse(result.html);
        
        if (jsonResponse.Type === BNC_RESPONSE.SUCCESS && jsonResponse.Value) {
          return this.parser.parse(jsonResponse.Value, accountName);
        } else if (BNC_RESPONSE.EMPTY.includes(jsonResponse.Type)) {
          return [];
        } else if (jsonResponse.Type === BNC_RESPONSE.SESSION_EXPIRED) {
          this.isAuthenticated = false;
          return [];
        }
      } catch {
        if (result.html.includes('Tbl_Transactions')) {
          return this.parser.parse(result.html, accountName);
        }
      }
      
    } catch (error: unknown) {
      this.log(`   POST to transactions list failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return [];
  }

  /**
   * Check if currently authenticated
   */
  isLoggedIn(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Logout from BNC (clears server-side session)
   * Call this before login if you suspect there's an existing session
   */
  async logout(): Promise<{ success: boolean; message: string }> {
    this.log('Attempting logout...');
    
    try {
      // Hit the logout endpoint to clear server-side session
      const html = await this.httpClient.getHtml(BNC_HTTP_URLS.LOGOUT, {
        'Referer': BNC_HTTP_URLS.WELCOME
      });
      
      // Check if we're back on login page (successful logout)
      const backOnLogin = html.includes('CardNumber') || html.includes('UserID') || html.includes('Frm_Login');
      
      // Reset local state
      this.isAuthenticated = false;
      this.currentToken = null;
      await this.httpClient.clearCookies();
      
      if (backOnLogin) {
        this.log('Logout successful - redirected to login page');
        return { success: true, message: 'Logged out successfully' };
      } else {
        this.log(' Logout endpoint hit but response unclear');
        return { success: true, message: 'Logout request sent (response unclear)' };
      }
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(` Logout error: ${message}`);
      // Still reset local state even if request failed
      this.isAuthenticated = false;
      this.currentToken = null;
      await this.httpClient.clearCookies();
      return { success: false, message };
    }
  }

  /**
   * Reset client state
   */
  async reset(): Promise<void> {
    this.isAuthenticated = false;
    this.currentToken = null;
    await this.httpClient.clearCookies();
    this.log('Client reset');
  }

  // ==========================================================================
  // Internal: Login Flow
  // ==========================================================================

  private async loadLoginPage(): Promise<string | null> {
    const html = await this.httpClient.getHtml(BNC_HTTP_URLS.LOGIN_PAGE);
    this.log(`   Got login page (${html.length} chars)`);
    
    const token = extractRequestVerificationToken(html);
    return token;
  }

  private async submitPreLogin(): Promise<{ success: boolean; token?: string; error?: string }> {
    if (!this.currentToken) {
      return { success: false, error: 'No token available' };
    }

    const formData = {
      '__RequestVerificationToken': this.currentToken,
      'prv_LoginType': 'NATURAL',
      'prv_InnerLoginType': '1',
      'CardNumber': this.credentials.card,
      'UserID': this.credentials.id
    };

    const result = await this.httpClient.postForm(BNC_HTTP_URLS.PRE_LOGIN, formData, {
      'Referer': BNC_HTTP_URLS.LOGIN_PAGE,
      'Accept': '*/*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    });

    this.log(`   PreLogin response (${result.html.length} chars): ${result.html.substring(0, 300)}...`);

    // Parse JSON response
    try {
      const response = JSON.parse(result.html) as BncPreLoginResponse;
      
      // BNC uses Type: 200 for success, Value contains HTML
      const isSuccess = response.Type === BNC_RESPONSE.SUCCESS || response.Succeeded === true;
      const htmlContent = response.Value || response.Content;
      
      this.log(`   PreLogin JSON: Type=${response.Type}, HasValue=${!!response.Value}, Message=${response.Message || 'none'}`);
      
      if (isSuccess) {
        // Extract new token from the returned HTML content
        if (htmlContent) {
          const newToken = extractRequestVerificationToken(htmlContent);
          if (newToken) {
            this.currentToken = newToken;
            this.log(`   Updated token from PreLogin response`);
          } else {
            this.log(`    No token found in Value/Content, looking for password field...`);
            // Check if we got the password form
            if (htmlContent.includes('UserPassword')) {
              this.log(`   Password form detected`);
            }
          }
        }
        return { success: true };
      } else {
        return { success: false, error: response.Message || `PreLogin failed with Type: ${response.Type}` };
      }
    } catch (e) {
      this.log(`   PreLogin JSON parse error: ${e}`);
      
      // If not JSON, check for redirect or error
      if (result.response.status === 200 && result.html.includes('UserPassword')) {
        // We got the password form - extract new token
        const newToken = extractRequestVerificationToken(result.html);
        if (newToken) {
          this.currentToken = newToken;
        }
        return { success: true };
      }
      
      return { success: false, error: `Unexpected response: ${result.html.substring(0, 200)}` };
    }
  }

  private async submitLogin(): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
    if (!this.currentToken) {
      return { success: false, error: 'No token available' };
    }

    const formData = {
      '__RequestVerificationToken': this.currentToken,
      'prv_InnerLoginType': '1',
      'UserPassword': this.credentials.password
    };

    const result = await this.httpClient.postForm(BNC_HTTP_URLS.LOGIN, formData, {
      'Referer': BNC_HTTP_URLS.LOGIN_PAGE,
      'Accept': '*/*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    });

    this.log(`   Login response (${result.html.length} chars): ${result.html.substring(0, 200)}...`);

    // Parse JSON response
    try {
      const response = JSON.parse(result.html) as BncLoginResponse;
      
      // BNC uses Type: 200 for success, 500 for errors
      const isSuccess = response.Type === BNC_RESPONSE.SUCCESS || response.Succeeded === true;
      const redirectUrl = response.Value || response.ReturnUrl;
      
      this.log(`   Login JSON: Type=${response.Type}, Value=${(response.Value || 'none').substring(0, 100)}`);
      
      if (isSuccess) {
        return { success: true, redirectUrl };
      } else {
        // Try to extract error message from HTML response
        let errorMessage = response.Message;
        
        if (!errorMessage && response.Value) {
          // Look for error message in the returned HTML
          const $ = cheerio.load(response.Value);
          const errorLabel = $('#LblMessage').text().trim();
          if (errorLabel) {
            errorMessage = errorLabel;
          }
          
          // Also check for "session already active" message pattern
          if (response.Value.includes('sesión previa activa')) {
            errorMessage = 'Existe una sesión previa activa, la nueva sesión ha sido denegada';
          }
        }
        
        return { success: false, error: errorMessage || `Login failed with Type: ${response.Type}` };
      }
    } catch (e) {
      this.log(`   Login JSON parse error: ${e}`);
      
      // Check for redirect
      if (result.location) {
        return { success: true, redirectUrl: result.location };
      }
      
      // If response is HTML, might still be successful
      if (result.response.status === 200) {
        return { success: true };
      }
      
      return { success: false, error: `Unexpected response status: ${result.response.status}` };
    }
  }

  private async verifyAuthentication(): Promise<boolean> {
    try {
      const html = await this.httpClient.getHtml(BNC_HTTP_URLS.WELCOME, {
        'Referer': BNC_HTTP_URLS.LOGIN_PAGE
      });

      // Check for indicators of successful login
      const $ = cheerio.load(html);
      
      // Look for logout button
      const hasLogout = $('#btn-logout').length > 0 || html.includes('btn-logout');
      
      // Look for welcome message or dashboard elements
      const hasWelcome = html.includes('Bienvenido') || html.includes('BNCNETHB');
      
      // Check we're not still on login page
      const notOnLogin = !html.includes('CardNumber') || !html.includes('UserID');

      if (hasLogout || hasWelcome) {
        return true;
      }

      if (notOnLogin && html.length > MIN_AUTHENTICATED_PAGE_LENGTH) {
        // Seems like we got past login
        return true;
      }

      this.log(`    Verification uncertain - hasLogout: ${hasLogout}, hasWelcome: ${hasWelcome}`);
      return false;

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`   Verification error: ${message}`);
      return false;
    }
  }

  // ==========================================================================
  // Internal: Logging
  // ==========================================================================

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BncHTTP] ${message}`);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a BNC HTTP client
 */
export function createBncHttpClient(
  credentials: BncCredentials,
  config?: BncHttpConfig
): BncHttpClient {
  return new BncHttpClient(credentials, config);
}

/**
 * Quick login function for simple use cases
 */
export async function quickHttpLogin(
  credentials: BncCredentials,
  config?: BncHttpConfig
): Promise<BncHttpLoginResult> {
  const client = createBncHttpClient(credentials, config);
  return client.login();
}

/**
 * Quick scrape function - login and fetch transactions in one call
 */
export async function quickHttpScrape(
  credentials: BncCredentials,
  config?: BncHttpConfig
): Promise<BncScrapingResult> {
  const client = createBncHttpClient(credentials, config);
  
  const loginResult = await client.login();
  if (!loginResult.success) {
    return {
      success: false,
      message: `Login failed: ${loginResult.error}`,
      data: [],
      timestamp: new Date(),
      bankName: 'BNC',
      error: loginResult.error
    };
  }

  return client.fetchLast25Transactions();
}
