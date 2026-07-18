/**
 * Banesco HTTP Client
 * 
 * IMPORTANT: Pure HTTP authentication does NOT work for Banesco.
 * The Banesco site requires a browser context (JavaScript execution, iframe handling).
 * 
 * This client provides:
 * 1. HTTP-based scraping AFTER authentication (use Playwright for login first)
 * 2. Utility functions for parsing Banesco pages with Cheerio
 * 3. Cookie-based session management
 * 
 * For authentication, use the Playwright-based BanescoAuth class, then transfer
 * the cookies to this client for faster data fetching.
 * 
 * Example hybrid usage:
 * ```typescript
 * // Step 1: Login with Playwright (handles JS, iframes, security questions)
 * const auth = new BanescoAuth(credentials);
 * const loginResult = await auth.login();
 * 
 * // Step 2: Extract cookies from Playwright session
 * const cookies = await auth.getPage()?.context().cookies();
 * 
 * // Step 3: Use HTTP client for fast data fetching
 * const httpClient = new BanescoHttpClient(credentials, { cookies });
 * const transactions = await httpClient.getTransactions();
 * ```
 */

import * as cheerio from 'cheerio';
import {
  parseLoginPage,
  parseSecurityQuestionsPage,
  parsePasswordPage,
  parseDashboardPage,
  parseTransactionsTable,
  parseCookies,
  serializeCookies,
  buildHuella,
  parseAspNetFormFields,
  parseAllHiddenFields,
  findBestTransactionPostBack,
  buildPostBackFormData,
  parseAccountsFromDashboard,
  type AspNetFormFields,
  type PostBackAction
} from './form-parser.js';

// ============================================================================
// Types
// ============================================================================

export interface BanescoHttpCredentials {
  username: string;
  password: string;
  securityQuestions: string; // Format: "keyword1:answer1,keyword2:answer2"
}

export interface BanescoHttpConfig {
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Custom user agent */
  userAgent?: string;
  /** Pre-set cookies (e.g., from Playwright session) */
  cookies?: Map<string, string> | Record<string, string>;
  /** Skip login attempt and use provided cookies directly */
  skipLogin?: boolean;
}

export interface BanescoHttpLoginResult {
  success: boolean;
  message: string;
  authenticated: boolean;
  cookies?: Map<string, string>;
  dashboardUrl?: string;
  error?: string;
}

export interface BanescoHttpTransaction {
  date: string;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  reference?: string;
}

export interface BanescoHttpScrapingResult {
  success: boolean;
  message: string;
  transactions: BanescoHttpTransaction[];
  error?: string;
}

export interface BanescoAccount {
  /** Account type (e.g., "Cuenta Corriente", "Cuenta Verde") */
  type: string;
  /** Account number */
  accountNumber: string;
  /** Available balance */
  balance: number;
  /** Currency (VES, USD, etc.) */
  currency: string;
  /** Postback target for navigating to this account's details */
  postbackTarget?: string;
  /** Postback argument */
  postbackArg?: string;
}

export interface BanescoAccountsResult {
  success: boolean;
  message: string;
  accounts: BanescoAccount[];
  error?: string;
}

export interface BanescoMovementsResult {
  success: boolean;
  message: string;
  accountNumber: string;
  transactions: BanescoHttpTransaction[];
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const BANESCO_URLS = {
  BASE: 'https://www.banesconline.com',
  // Main login page (contains the iframe)
  LOGIN_PAGE: 'https://www.banesconline.com/mantis/Website/Login.aspx',
  // Iframe content URLs - need proper Referer from Login.aspx
  LOGIN_IFRAME_INICIO: 'https://www.banesconline.com/mantis/Website/CAU/inicio/inicio.aspx?svc=mantis&Banco=01',
  LOGIN_IFRAME_FORM: 'https://www.banesconline.com/mantis/Website/CAU/inicio/LoginDNA.aspx?svc=mantis',
  SECURITY_QUESTIONS: 'https://www.banesconline.com/mantis/Website/CAU/Inicio/AU_ValDNA.aspx',
  PASSWORD: 'https://www.banesconline.com/mantis/Website/CAU/Inicio/ContrasenaDNA.aspx?svc=mantis',
  // Legacy dashboard URL (Banesco often redirects authenticated users to Login.aspx container + iframe)
  DASHBOARD: 'https://www.banesconline.com/Mantis/WebSite/Default.aspx',
  // Consultas pages (direct URLs for faster navigation)
  CONSULTAS_CUENTAS: 'https://www.banesconline.com/Mantis/WebSite/Cuentas/ConsultaCuentas.aspx',
  // Note: The actual movements page is MovimientosCuenta.aspx under consultamovimientoscuenta folder
  MOVIMIENTOS_CUENTA: 'https://www.banesconline.com/Mantis/WebSite/consultamovimientoscuenta/MovimientosCuenta.aspx'
};

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============================================================================
// Main Client
// ============================================================================

export class BanescoHttpClient {
  private credentials: BanescoHttpCredentials;
  private config: {
    timeout: number;
    debug: boolean;
    userAgent: string;
    cookies?: Map<string, string> | Record<string, string>;
    skipLogin: boolean;
  };
  private cookies: Map<string, string> = new Map();
  private isAuthenticated: boolean = false;
  private securityQuestionsMap: Map<string, string>;

  constructor(credentials: BanescoHttpCredentials, config: BanescoHttpConfig = {}) {
    this.credentials = credentials;
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
      cookies: config.cookies ?? undefined,
      skipLogin: config.skipLogin ?? false
    };
    
    this.securityQuestionsMap = this.parseSecurityQuestions(credentials.securityQuestions);
    
    // Import pre-set cookies if provided
    if (config.cookies) {
      if (config.cookies instanceof Map) {
        config.cookies.forEach((value, name) => this.cookies.set(name, value));
      } else {
        Object.entries(config.cookies).forEach(([name, value]) => this.cookies.set(name, value));
      }
      this.isAuthenticated = config.skipLogin ?? false;
      this.log(`BanescoHttpClient initialized with ${this.cookies.size} pre-set cookies`);
    } else {
      this.log(`BanescoHttpClient initialized`);
    }
    
    this.log(`   Username: ${credentials.username.substring(0, 3)}***`);
    this.log(`   Security questions: ${this.securityQuestionsMap.size} configured`);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Perform complete login flow
   * 
   * NOTE: Pure HTTP login does NOT work for Banesco. The site requires
   * JavaScript and browser context. Use the Playwright-based BanescoAuth
   * for login, then import cookies to this client for data fetching.
   */
  async login(): Promise<BanescoHttpLoginResult> {
    // If already authenticated via imported cookies, skip login
    if (this.isAuthenticated && this.cookies.size > 0) {
      this.log('Already authenticated via imported cookies');
      return {
        success: true,
        message: 'Already authenticated via imported cookies',
        authenticated: true,
        cookies: new Map(this.cookies)
      };
    }
    
    this.log('🚀 Starting Banesco HTTP login...');
    this.log(' WARNING: Pure HTTP login may fail. Banesco requires JavaScript.');
    const startTime = Date.now();

    try {
      // Step 1: Load login page and get initial cookies + form fields
      this.log('Step 1: Loading login page...');
      const loginPageData = await this.loadLoginPage();
      
      // Step 2: Submit username
      this.log('Step 2: Submitting username...');
      const usernameResult = await this.submitUsername(loginPageData.formFields, loginPageData.allHiddenFields);
      
      // Step 3: Handle security questions (if redirected there)
      this.log('Step 3: Handling security questions...');
      const securityResult = await this.submitSecurityQuestions(usernameResult.nextUrl);
      
      // Step 4: Submit password
      this.log('Step 4: Submitting password...');
      const passwordResult = await this.submitPassword(securityResult.nextUrl);
      
      // Step 5: Verify authentication
      this.log('Step 5: Verifying authentication...');
      const verified = await this.verifyAuthentication(passwordResult.nextUrl);
      
      const elapsed = Date.now() - startTime;
      
      if (verified.isAuthenticated) {
        this.isAuthenticated = true;
        this.log(`Login successful in ${elapsed}ms`);
        
        return {
          success: true,
          message: `Authentication successful in ${elapsed}ms`,
          authenticated: true,
          cookies: new Map(this.cookies),
          dashboardUrl: verified.finalUrl
        };
      } else {
        return {
          success: false,
          message: 'Authentication failed - could not verify login',
          authenticated: false,
          error: 'Verification failed'
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
   * Get transactions (must be logged in first)
   * 
   * Modern Banesco flow often uses an authenticated Login.aspx container + iframe.
   * So we prefer the stable, direct paths:
   * - Fetch accounts from ConsultaCuentas.aspx
   * - Fetch movements from MovimientosCuenta.aspx (discover field names/options and submit)
   *
   * We keep a legacy fallback that attempts WebForms postback navigation from Default.aspx.
   */
  async getTransactions(): Promise<BanescoHttpScrapingResult> {
    if (!this.isAuthenticated) {
      return {
        success: false,
        message: 'Not authenticated. Call login() first or import cookies from Playwright.',
        transactions: [],
        error: 'Not authenticated'
      };
    }

    try {
      this.log('Fetching transactions...');

      // Preferred: accounts -> per-account movements
      const accountsResult = await this.getAccounts();
      if (accountsResult.success && accountsResult.accounts.length > 0) {
        const all: BanescoHttpTransaction[] = [];
        for (const acc of accountsResult.accounts) {
          const mov = await this.getAccountMovements(acc.accountNumber);
          if (mov.success && mov.transactions.length > 0) {
            all.push(...mov.transactions);
          }
        }

        this.log(`Found ${all.length} transactions (accounts-based)`);
        return {
          success: true,
          message: `Found ${all.length} transactions (accounts-based)`,
          transactions: all
        };
      }

      // If we couldn't discover accounts, try direct movements page (first available account)
      this.log('Accounts not found; trying direct movements page...');
      const directMov = await this.getAccountMovements('');
      if (directMov.success) {
        return {
          success: true,
          message: directMov.message,
          transactions: directMov.transactions
        };
      }

      // Legacy fallback: try dashboard postback navigation (older Banesco layouts)
      this.log('Falling back to legacy dashboard postback navigation...');
      const dashboardHtml = await this.fetchPage(BANESCO_URLS.DASHBOARD);

      const { rows, tableFound } = parseTransactionsTable(dashboardHtml);
      if (tableFound && rows.length > 0) {
        const transactions = this.parseTransactionRows(rows);
        return {
          success: true,
          message: `Found ${transactions.length} transactions on legacy dashboard`,
          transactions
        };
      }

      const bestPostBack = findBestTransactionPostBack(dashboardHtml);
      if (!bestPostBack) {
        return {
          success: true,
          message: 'No transaction navigation found (legacy).',
          transactions: []
        };
      }

      const transactionsHtml = await this.executePostBack(dashboardHtml, bestPostBack);
      if (!transactionsHtml) {
        return {
          success: false,
          message: 'Legacy postback navigation failed',
          transactions: [],
          error: 'Postback navigation failed'
        };
      }

      const parsed = parseTransactionsTable(transactionsHtml);
      if (!parsed.tableFound) {
        return {
          success: true,
          message: 'Legacy navigation reached a page without a transaction table',
          transactions: []
        };
      }

      const legacyTransactions = this.parseTransactionRows(parsed.rows);
      return {
        success: true,
        message: `Found ${legacyTransactions.length} transactions (legacy)`,
        transactions: legacyTransactions
      };

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Error fetching transactions: ${message}`);
      return {
        success: false,
        message,
        transactions: [],
        error: message
      };
    }
  }

  /**
   * Execute a WebForms postback to navigate within the authenticated session
   */
  private async executePostBack(currentPageHtml: string, action: PostBackAction): Promise<string | null> {
    try {
      // Parse the current page's hidden fields
      const formFields = parseAspNetFormFields(currentPageHtml);
      const allHiddenFields = parseAllHiddenFields(currentPageHtml);
      
      // Build the postback form data
      const formData = buildPostBackFormData(formFields, allHiddenFields, action);
      
      // POST to the dashboard URL (WebForms posts back to the same page)
      const response = await this.postForm(BANESCO_URLS.DASHBOARD, formData);
      
      // Handle redirects if needed
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const redirectUrl = new URL(location, BANESCO_URLS.BASE).toString();
          this.log(`   ↪️ Following redirect to: ${redirectUrl.split('/').pop()}`);
          return await this.fetchPage(redirectUrl);
        }
      }
      
      return await response.text();
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`   Postback execution failed: ${message}`);
      return null;
    }
  }

  /**
   * Check if currently authenticated
   */
  isLoggedIn(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Get current cookies (for debugging)
   */
  getCookies(): Map<string, string> {
    return new Map(this.cookies);
  }

  /**
   * Import cookies from a Playwright context
   * Use this after authenticating with Playwright to enable HTTP-based scraping
   * 
   * Accepts the full Playwright cookie shape from page.context().cookies()
   * which includes { name, value, domain, path, expires, httpOnly, secure, sameSite }
   * but only requires name and value.
   */
  importCookiesFromPlaywright(playwrightCookies: ReadonlyArray<{ name: string; value: string }>): void {
    if (!playwrightCookies || !Array.isArray(playwrightCookies)) {
      this.log(' No cookies provided to import');
      return;
    }
    
    let importedCount = 0;
    for (const cookie of playwrightCookies) {
      if (cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string') {
        this.cookies.set(cookie.name, cookie.value);
        importedCount++;
        this.log(`   [Cookie] Imported: ${cookie.name}`);
      }
    }
    
    this.isAuthenticated = importedCount > 0;
    this.log(`Imported ${importedCount} cookies from Playwright (${playwrightCookies.length} provided)`);
  }

  /**
   * Set authenticated state (use after importing cookies from external source)
   */
  setAuthenticated(authenticated: boolean): void {
    this.isAuthenticated = authenticated;
  }

  // ==========================================================================
  // Account & Movements API
  // ==========================================================================

  /**
   * Get list of accounts from the dashboard
   */
  async getAccounts(): Promise<BanescoAccountsResult> {
    if (!this.isAuthenticated) {
      return {
        success: false,
        message: 'Not authenticated. Call login() first or import cookies from Playwright.',
        accounts: [],
        error: 'Not authenticated'
      };
    }

    try {
      this.log('📋 Fetching accounts...');

      // Prefer the dedicated accounts page (more stable than Default.aspx in newer layouts)
      let html = await this.fetchPage(BANESCO_URLS.CONSULTAS_CUENTAS);

      // If we hit an error or login container, fall back to the legacy dashboard
      if (this.isBanescoErrorPage(html) || this.looksLikeLoginContainer(html)) {
        this.log('   Accounts page looks invalid (error/login). Falling back to legacy dashboard...');
        html = await this.fetchPage(BANESCO_URLS.DASHBOARD);
      }

      // Debug: save HTML if in debug mode
      if (this.config.debug) {
        const fs = await import('fs');
        fs.writeFileSync('debug-banesco-accounts.html', html);
        this.log(`   📄 Saved accounts HTML to debug-banesco-accounts.html (${html.length} chars)`);
      }

      const parsedAccounts = parseAccountsFromDashboard(html);
      
      const accounts: BanescoAccount[] = parsedAccounts.map(acc => ({
        type: acc.type,
        accountNumber: acc.accountNumber,
        balance: acc.balance,
        currency: acc.currency,
        postbackTarget: acc.postbackTarget,
        postbackArg: acc.postbackArg
      }));
      
      this.log(`Found ${accounts.length} accounts`);
      
      return {
        success: true,
        message: `Found ${accounts.length} accounts`,
        accounts
      };

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Error fetching accounts: ${message}`);
      return {
        success: false,
        message,
        accounts: [],
        error: message
      };
    }
  }

  /**
   * Get movement history for a specific account
   * Uses dashboard postback to navigate to movements, then submits the date form
   * Handles pagination to fetch ALL transactions across multiple pages
   */
  async getAccountMovements(accountNumber: string): Promise<BanescoMovementsResult> {
    if (!this.isAuthenticated) {
      return {
        success: false,
        message: 'Not authenticated.',
        accountNumber,
        transactions: [],
        error: 'Not authenticated'
      };
    }

    try {
      const label = accountNumber ? accountNumber : '(auto)';
      this.log(`Fetching movements for ${label}...`);

      // Step 1: Load movements page directly (newer layouts + iframe container make Default.aspx unreliable)
      this.log(`   Step 1: Loading movements page...`);
      const movementsPageHtml = await this.fetchPage(BANESCO_URLS.MOVIMIENTOS_CUENTA);

      if (this.config.debug) {
        const fs = await import('fs');
        fs.writeFileSync('debug-banesco-movements-form.html', movementsPageHtml);
      }

      if (this.isBanescoErrorPage(movementsPageHtml) || this.looksLikeLoginContainer(movementsPageHtml)) {
        return {
          success: false,
          message: 'Movements page returned an error/login page (session may be invalid or Banesco blocked the request)',
          accountNumber,
          transactions: [],
          error: 'Movements page not accessible'
        };
      }

      // Step 2: Submit the movements form (discover field names/options from HTML)
      this.log(`   Step 2: Submitting movements filter form...`);
      let currentPageHtml = await this.submitMovementsDateForm(movementsPageHtml, accountNumber);
      
      if (!currentPageHtml) {
        return {
          success: false,
          message: 'Failed to submit date filter form',
          accountNumber,
          transactions: [],
          error: 'Form submission failed'
        };
      }
      
      this.log(`   Got transactions page (${currentPageHtml.length} chars)`);
      if (this.config.debug) {
        const fs = await import('fs');
        fs.writeFileSync('debug-banesco-transactions.html', currentPageHtml);
      }
      
      // Step 3: Parse transactions from first page and handle pagination
      this.log(`   Step 3: Parsing transactions (with pagination)...`);
      const allTransactions: BanescoHttpTransaction[] = [];
      let pageNumber = 1;
      const maxPages = 50; // Safety limit to prevent infinite loops
      
      while (pageNumber <= maxPages) {
        // Parse transactions from current page
        const pageTransactions = this.parseMovementsFromHtml(currentPageHtml, accountNumber);
        
        if (pageTransactions.length > 0) {
          this.log(`   Page ${pageNumber}: Found ${pageTransactions.length} transactions`);
          allTransactions.push(...pageTransactions);
        } else if (pageNumber === 1) {
          // No transactions on first page - check for "no movements" message
          const pageText = currentPageHtml.toLowerCase();
          if (pageText.includes('no posee movimientos') || pageText.includes('no hay movimientos')) {
            this.log(`   No movements in selected period`);
            return {
              success: true,
              message: 'No movements found in the selected period',
              accountNumber,
              transactions: []
            };
          }
        }
        
        // Check for pagination - look for "Siguiente" (Next) button
        const nextPageHtml = await this.fetchNextPage(currentPageHtml);
        
        if (!nextPageHtml) {
          // No more pages
          this.log(`   No more pages (reached end at page ${pageNumber})`);
          break;
        }
        
        // Move to next page
        currentPageHtml = nextPageHtml;
        pageNumber++;
        
        if (this.config.debug) {
          const fs = await import('fs');
          fs.writeFileSync(`debug-banesco-transactions-page${pageNumber}.html`, currentPageHtml);
        }
      }
      
      if (allTransactions.length > 0) {
        this.log(`   Total: ${allTransactions.length} transactions across ${pageNumber} page(s)`);
        return {
          success: true,
          message: `Found ${allTransactions.length} movements across ${pageNumber} page(s)`,
          accountNumber,
          transactions: allTransactions
        };
      }
      
      this.log(`   No transactions parsed from result`);
      return {
        success: true,
        message: 'Transactions page loaded but no data found',
        accountNumber,
        transactions: []
      };

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Error: ${message}`);
      return {
        success: false,
        message,
        accountNumber,
        transactions: [],
        error: message
      };
    }
  }

  /**
   * Fetch the next page of transactions by clicking the "Siguiente" button
   * Returns null if there's no next page button
   */
  private async fetchNextPage(currentPageHtml: string): Promise<string | null> {
    try {
      const $ = cheerio.load(currentPageHtml);
      
      // Look for "Siguiente" (Next) button - various possible IDs/names
      const $nextBtn = $('input[type="submit"], button').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        const value = (($(el).attr('value') || '') as string).toLowerCase();
        const text = ($(el).text() || '').toLowerCase();
        return (
          id.includes('btnsig') ||
          name.includes('btnsig') ||
          value.includes('siguiente') ||
          text.includes('siguiente') ||
          id.includes('btnnext') ||
          name.includes('btnnext')
        );
      }).first();
      
      if (!$nextBtn.length) {
        // No next button found
        return null;
      }
      
      const btnName = ($nextBtn.attr('name') || '').trim();
      const btnValue = (($nextBtn.attr('value') as string) || 'Siguiente').trim();
      
      if (!btnName) {
        this.log(`   Found next button but couldn't get its name`);
        return null;
      }
      
      this.log(`   📄 Fetching next page (clicking ${btnName})...`);
      
      // Build form data for pagination postback
      const formFields = parseAspNetFormFields(currentPageHtml);
      const allHiddenFields = parseAllHiddenFields(currentPageHtml);
      
      const formData: Record<string, string> = {
        ...allHiddenFields,
        ...formFields,
        __EVENTTARGET: '',
        __EVENTARGUMENT: '',
        [btnName]: btnValue,
      };
      
      // Submit the pagination form
      const response = await this.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, formData);
      
      // Handle redirect if needed
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
          this.log(`   ↪️ Following redirect to: ${absoluteUrl.split('/').pop()}`);
          return await this.fetchPage(absoluteUrl);
        }
      }
      
      const nextHtml = await response.text();
      
      // Verify we got a valid page (not an error page)
      if (this.isBanescoErrorPage(nextHtml)) {
        this.log(`   Next page returned an error`);
        return null;
      }
      
      return nextHtml;
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`   Error fetching next page: ${message}`);
      return null;
    }
  }

  /**
   * Submit the date filter form on movements page to fetch actual transactions
   */
  private async submitMovementsDateForm(html: string, desiredAccountNumber: string): Promise<string | null> {
    try {
      const formFields = parseAspNetFormFields(html);
      const allHiddenFields = parseAllHiddenFields(html);

      const $ = cheerio.load(html);

      const formData: Record<string, string> = {
        ...allHiddenFields,
        ...formFields,
      };

      // Always ensure WebForms postback basics exist
      if (typeof formData.__EVENTTARGET !== 'string') formData.__EVENTTARGET = '';
      if (typeof formData.__EVENTARGUMENT !== 'string') formData.__EVENTARGUMENT = '';

      // Discover account dropdown (ddlCuenta)
      const $accountSelect = $('select').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        return id.includes('ddlcuenta') || name.includes('ddlcuenta');
      }).first();

      if ($accountSelect.length) {
        const accountField = ($accountSelect.attr('name') || $accountSelect.attr('id') || '').trim();
        const options = $accountSelect.find('option').toArray().map((opt) => {
          const $opt = $(opt);
          return {
            value: ($opt.attr('value') || '').trim(),
            text: ($opt.text() || '').trim(),
            selected: $opt.is(':selected')
          };
        }).filter(o => o.value);

        const targetText = (desiredAccountNumber || '').replace(/\s/g, '');
        const chosen =
          (targetText
            ? options.find(o => o.text.replace(/\s/g, '').includes(targetText))
            : undefined) ||
          options.find(o => o.selected) ||
          options[0];

        if (accountField && chosen) {
          formData[accountField] = chosen.value;
          this.log(`   Selected account option: "${chosen.text}" (${chosen.value})`);
        } else {
          this.log(`   Account dropdown found but could not select an option`);
        }
      } else {
        this.log(`   No account dropdown found (ddlCuenta)`);
      }

      // Discover period dropdown (ddlPeriodo) and try multiple options (widen range if month has no txns)
      const $periodSelect = $('select').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        return id.includes('ddlperiodo') || name.includes('ddlperiodo');
      }).first();

      const periodField = $periodSelect.length ? (($periodSelect.attr('name') || $periodSelect.attr('id') || '').trim()) : '';
      const periodOptions = $periodSelect.length
        ? $periodSelect.find('option').toArray().map((opt) => {
            const $opt = $(opt);
            return {
              value: ($opt.attr('value') || '').trim(),
              text: ($opt.text() || '').trim(),
              selected: $opt.is(':selected'),
            };
          }).filter(o => o.value)
        : [];

      // Order period options: prefer options that cover ~30 days, then wider ranges, then the rest
      const orderedPeriods = periodOptions.length
        ? [
            // First: options that explicitly mention "30 días", "últimos", or "mes actual"
            ...periodOptions.filter(o => /30\s*d[ií]as?|\u00faltim|mes\s+actual/i.test(o.text)),
            // Then: wider ranges that should include recent transactions
            ...periodOptions.filter(o =>
              /semestre|trimestre|mes anterior/i.test(o.text) &&
              !/30\s*d[ií]as?|\u00faltim|mes\s+actual/i.test(o.text)
            ),
            // Finally: everything else not already included
            ...periodOptions.filter(o =>
              !/30\s*d[ií]as?|\u00faltim|mes\s+actual|semestre|trimestre|mes anterior/i.test(o.text)
            ),
          ]
        : [{ value: 'PeriodoMes', text: 'PeriodoMes', selected: true }];

      // Discover date fields if present (dtFechaDesde / dtFechaHasta)
      const $fromInput = $('input').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        return id.includes('dtfechadesde') || name.includes('dtfechadesde');
      }).first();
      const $toInput = $('input').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        return id.includes('dtfechahasta') || name.includes('dtfechahasta');
      }).first();

      const fromField = $fromInput.length ? (($fromInput.attr('name') || $fromInput.attr('id') || '').trim()) : '';
      const toField = $toInput.length ? (($toInput.attr('name') || $toInput.attr('id') || '').trim()) : '';

      const today = new Date();
      const thirtyDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
      const formatDate = (d: Date) =>
        `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;

      // Discover consult/submit button
      const $consultBtn = $('input[type="submit"], input[type="button"], button').filter((_, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const name = ($(el).attr('name') || '').toLowerCase();
        const value = (($(el).attr('value') || '') as string).toLowerCase();
        const text = ($(el).text() || '').toLowerCase();
        return (
          id.includes('btnmostrar') ||
          name.includes('btnmostrar') ||
          value.includes('consultar') ||
          text.includes('consultar')
        );
      }).first();

      const consultField = $consultBtn.length ? (($consultBtn.attr('name') || $consultBtn.attr('id') || '').trim()) : 'ctl00$cp$btnMostrar';
      const consultValue = (($consultBtn.attr('value') as string) || 'Consultar').trim();

      // Determine query mode: prefer "rdbRango" (date range) when date inputs exist,
      // fall back to "rdbPeriodo" (period dropdown) otherwise. We don’t hardcode the exact field name; instead we set it only if present in hidden fields.
      const tipoConsultaKey = Object.keys(formData).find(k => k.toLowerCase().includes('tipoconsulta'));
      const useDateRangeMode = fromField && toField;

      if (tipoConsultaKey) {
        formData[tipoConsultaKey] = useDateRangeMode ? 'rdbRango' : 'rdbPeriodo';
      }

      // When using date range mode, submit once with last-30-days range.
      // When using period mode, try multiple period options until we get results.
      if (useDateRangeMode) {
        // Use last 30 days range to ensure we always cover recent transactions
        formData[fromField] = formatDate(thirtyDaysAgo);
        formData[toField] = formatDate(today);

        // "Click" consult
        if (consultField) formData[consultField] = consultValue;

        this.log(`   📤 Posting movements form (rdbRango: ${formatDate(thirtyDaysAgo)} - ${formatDate(today)})`);
        const response = await this.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, formData);

        // Handle redirect if needed
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
            this.log(`   ↪️ Following redirect to: ${absoluteUrl.split('/').pop()}`);
            return await this.fetchPage(absoluteUrl);
          }
        }

        return await response.text();
      }

      // Fallback: period-based query (try multiple period options)
      for (const period of orderedPeriods.slice(0, 5)) {
        const attemptForm: Record<string, string> = { ...formData };

        if (periodField) attemptForm[periodField] = period.value;

        // Set partial date fields if only one exists (rare fallback path)
        if (fromField) {
          attemptForm[fromField] = formatDate(thirtyDaysAgo);
        }
        if (toField) {
          attemptForm[toField] = formatDate(today);
        }

        // "Click" consult
        if (consultField) attemptForm[consultField] = consultValue;

        this.log(`   📤 Posting movements form (period=${period.value || 'n/a'})`);
        const response = await this.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, attemptForm);
      
        // Handle redirect if needed
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
            this.log(`   ↪️ Following redirect to: ${absoluteUrl.split('/').pop()}`);
            const redirectedHtml = await this.fetchPage(absoluteUrl);
            const txs = this.parseMovementsFromHtml(redirectedHtml, desiredAccountNumber);
            if (txs.length > 0) return redirectedHtml;
            if (this.pageSaysNoMovements(redirectedHtml)) continue;
            // otherwise keep trying other periods
            continue;
          }
        }

        const htmlOut = await response.text();
        const txs = this.parseMovementsFromHtml(htmlOut, desiredAccountNumber);
        if (txs.length > 0) return htmlOut;
        if (this.pageSaysNoMovements(htmlOut)) continue;

        // If we got an error page, stop trying further (likely blocked)
        if (this.isBanescoErrorPage(htmlOut)) return htmlOut;
      }

      // Return last attempt's result (or null if no attempts)
      return null;
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`   Form submit failed: ${message}`);
      return null;
    }
  }

  private looksLikeLoginContainer(html: string): boolean {
    const lower = html.toLowerCase();
    // Authenticated container still contains salir.aspx; unauthenticated login has txtUsuario
    const hasSalir = lower.includes('salir.aspx') || lower.includes('logout');
    const hasLoginInputs = lower.includes('txtusuario') || lower.includes('txtloginname') || lower.includes('login.aspx');
    // If it has login inputs without salir, it's likely not authenticated.
    return hasLoginInputs && !hasSalir;
  }

  private isBanescoErrorPage(html: string): boolean {
    const lower = html.toLowerCase();
    return lower.includes('error.aspx') || lower.includes('en estos momentos no podemos procesar su operación') || lower.includes('gueg001');
  }

  private pageSaysNoMovements(html: string): boolean {
    const pageText = cheerio.load(html)('body').text().toLowerCase();
    return (
      pageText.includes('no posee movimientos') ||
      pageText.includes('no hay movimientos') ||
      pageText.includes('no existen movimientos') ||
      pageText.includes('sin movimientos') ||
      pageText.includes('no se encontraron movimientos') ||
      pageText.includes('no hay registros') ||
      pageText.includes('sin registros para mostrar')
    );
  }

  /**
   * Parse movements/transactions from HTML page
   * Uses flexible parsing approach similar to the Playwright scraper
   */
  private parseMovementsFromHtml(html: string, _accountNumber: string): BanescoHttpTransaction[] {
    const $ = cheerio.load(html);
    const transactions: BanescoHttpTransaction[] = [];
    
    // First check for "no movements" messages
    const pageText = $('body').text().toLowerCase();
    const noMovementsPatterns = [
      'no posee movimientos',
      'no hay movimientos',
      'no existen movimientos',
      'sin movimientos',
      'no se encontraron movimientos',
      'no hay registros',
      'sin registros para mostrar'
    ];
    
    if (noMovementsPatterns.some(pattern => pageText.includes(pattern))) {
      this.log('   No movements message found on page');
      return [];
    }
    
    // Look for ALL tables and analyze each one
    $('table').each((_, table) => {
      const $table = $(table);
      const rows = $table.find('tr');
      
      if (rows.length < 2) return; // Skip tables with only header or no data
      
      // Check if headers contain transaction-related keywords
      const headerRow = rows.first();
      const headerText = headerRow.text().toLowerCase();
      const containsTransactionHeaders = /fecha|date|monto|amount|descripci[oó]n|description|saldo|balance|d[eé]bito|cr[eé]dito|referencia/i.test(headerText);
      
      if (!containsTransactionHeaders) return;
      
      this.log(`   Found table with transaction headers: ${headerText.substring(0, 50)}...`);
      
      // Parse data rows (skip header)
      rows.slice(1).each((_, rowEl) => {
        const $row = $(rowEl);
        const cells: string[] = [];
        
        $row.find('td').each((_, cellEl) => {
          cells.push($(cellEl).text().trim());
        });
        
        if (cells.length < 3) return;
        
        // Use flexible parsing (similar to Playwright scraper)
        const tx = this.parseTransactionRowFlexible(cells);
        if (tx) {
          transactions.push(tx);
        }
      });
    });
    
    return transactions;
  }

  /**
   * Flexible row parsing - finds date, amount, description in any cell position
   */
  private parseTransactionRowFlexible(cells: string[]): BanescoHttpTransaction | null {
    // Find date (DD/MM/YYYY format)
    let date: string | null = null;
    for (const cell of cells) {
      const dateMatch = cell.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
      if (dateMatch) {
        const [, day, month, year] = dateMatch;
        const fullYear = year.length === 2 ? `20${year}` : year;
        date = `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        break;
      }
    }
    
    // Find amount (number with comma/period)
    let amount = 0;
    let amountCell = '';
    for (const cell of cells) {
      // Look for numeric cells with decimal separators
      const cleanCell = cell.replace(/\s/g, '');
      if (/^[\d.,-]+$/.test(cleanCell) && (cleanCell.includes(',') || cleanCell.includes('.'))) {
        amountCell = cell;
        // Parse Spanish format (1.234,56)
        const normalized = cleanCell.replace(/\./g, '').replace(/,/g, '.');
        amount = Math.abs(parseFloat(normalized)) || 0;
        if (amount > 0) break;
      }
    }
    
    // Find D/C indicator (D, C, +, or -)
    let transactionType: 'debit' | 'credit' = 'credit';
    for (const cell of cells) {
      const trimmed = cell.trim().toUpperCase();
      if (trimmed === 'D' || trimmed === '-') {
        transactionType = 'debit';
        break;
      } else if (trimmed === 'C' || trimmed === '+') {
        transactionType = 'credit';
        break;
      }
    }
    
    // Also check if amount was negative
    if (amountCell.includes('-')) {
      transactionType = 'debit';
    }
    
    // Find reference (numeric string of 6+ digits, not a date or amount)
    let reference: string | undefined = undefined;
    for (const cell of cells) {
      const trimmed = cell.trim().replace(/\s/g, '');
      // Reference is typically a pure numeric string with 6+ digits
      // Skip if it looks like a date (contains / or -)
      if (/[/-]/.test(trimmed)) continue;
      // Skip if it looks like an amount (contains comma or period as decimal)
      if (/[.,]/.test(trimmed)) continue;
      // Skip D/C indicators
      if (/^[DC]$/i.test(trimmed)) continue;
      // Match 6+ digit reference numbers
      if (/^\d{6,}$/.test(trimmed)) {
        reference = trimmed;
        break;
      }
    }

    // Find description (longest text that's not date/amount/reference)
    let description = '';
    for (const cell of cells) {
      const trimmed = cell.trim();
      // Skip if it looks like date, amount, D/C, or reference
      if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(trimmed)) continue;
      if (/^[\d.,-]+$/.test(trimmed.replace(/\s/g, ''))) continue;
      if (/^[DC]$/i.test(trimmed)) continue;
      if (/^\d{6,}$/.test(trimmed.replace(/\s/g, ''))) continue;
      
      if (trimmed.length > description.length && trimmed.length > 3) {
        description = trimmed;
      }
    }
    
    // Require at least date and amount
    if (!date || amount === 0) {
      return null;
    }
    
    return {
      date,
      description: description || 'Transacción',
      amount,
      type: transactionType,
      reference
    };
  }

  // ==========================================================================
  // Internal: Login Flow Steps
  // ==========================================================================

  private async loadLoginPage(): Promise<{
    formFields: AspNetFormFields;
    allHiddenFields: Record<string, string>;
  }> {
    // Step 1: Hit the main login page to get session cookie
    const mainPageHtml = await this.fetchPage(BANESCO_URLS.LOGIN_PAGE);
    this.log(`   Got main login page (${mainPageHtml.length} chars)`);
    
    // Step 2: Load the iframe content (inicio.aspx -> redirects to LoginDNA.aspx)
    // Use Referer from the main page to simulate browser iframe load
    const inicioResponse = await this.makeRequest(BANESCO_URLS.LOGIN_IFRAME_INICIO, { 
      redirect: 'follow',
      headers: {
        'Referer': BANESCO_URLS.LOGIN_PAGE,
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
      }
    });
    let iframeHtml = await inicioResponse.text();
    this.log(`   Got iframe content (${iframeHtml.length} chars)`);
    
    // Check for the actual form content (various field name patterns)
    const hasUsernameField = iframeHtml.includes('txtloginname') || 
                             iframeHtml.includes('txtUsuario') ||
                             iframeHtml.includes('ddpControles');
    
    if (!hasUsernameField) {
      // Try direct LoginDNA URL if inicio didn't work
      this.log(`    Form not found in inicio response, trying direct URL...`);
      
      const directResponse = await this.makeRequest(BANESCO_URLS.LOGIN_IFRAME_FORM, {
        redirect: 'follow',
        headers: {
          'Referer': BANESCO_URLS.LOGIN_PAGE,
          'Sec-Fetch-Dest': 'iframe',
          'Sec-Fetch-Mode': 'navigate', 
          'Sec-Fetch-Site': 'same-origin'
        }
      });
      iframeHtml = await directResponse.text();
      this.log(`   Got direct LoginDNA content (${iframeHtml.length} chars)`);
    }
    
    // Final check for form content
    const hasForm = iframeHtml.includes('txtloginname') || 
                    iframeHtml.includes('txtUsuario') ||
                    iframeHtml.includes('ddpControles');
    
    if (!hasForm) {
      // Save HTML for debugging
      const fs = await import('fs');
      fs.writeFileSync('debug-banesco-login.html', iframeHtml);
      this.log(`    Saved HTML to debug-banesco-login.html`);
      this.log(`    HTML preview: ${iframeHtml.substring(0, 500)}...`);
      
      throw new Error('Login form not found. The Banesco site may require JavaScript or a browser context.');
    }
    
    this.log(`   Found login form in HTML`);
    
    const parsed = parseLoginPage(iframeHtml);
    
    // Try to find VIEWSTATE with regex if cheerio missed it
    if (parsed.formFields.__VIEWSTATE.length < 500) {
      const viewStateMatch = iframeHtml.match(/name="__VIEWSTATE"[^>]*value="([^"]+)"/);
      if (viewStateMatch && viewStateMatch[1].length > parsed.formFields.__VIEWSTATE.length) {
        parsed.formFields.__VIEWSTATE = viewStateMatch[1];
        this.log(`   Found longer VIEWSTATE via regex (${parsed.formFields.__VIEWSTATE.length} chars)`);
      }
    }
    
    this.log(`   Got VIEWSTATE (${parsed.formFields.__VIEWSTATE.length} chars)`);
    this.log(`   Hidden fields: ${Object.keys(parsed.allHiddenFields).length}`);
    
    return {
      formFields: parsed.formFields,
      allHiddenFields: parsed.allHiddenFields
    };
  }

  private async submitUsername(
    formFields: AspNetFormFields,
    allHiddenFields: Record<string, string>
  ): Promise<{ nextUrl: string }> {
    const formData: Record<string, string> = {
      ...formFields,
      huella: buildHuella(),
      txtBatUsuario: '',
      modal: '',
      urlRed: '',
      ValidarVacio: '^$',
      Hidden1: '',
      ClaveFormato: allHiddenFields['ClaveFormato'] || '^[a-zA-ZñÑ0-9!#\\$\\%\\?¡¿\\*_\\.-]{8,15}$',
      UsuarioFormato: allHiddenFields['UsuarioFormato'] || '^[a-zA-Z0-9_.]{4,10}$',
      RangoUsuario: allHiddenFields['RangoUsuario'] || '6|10',
      RangoClave: allHiddenFields['RangoClave'] || '8|15',
      ErrorUsuario: 'Por favor indique su Usuario.',
      ErrorUsuarioInvalido: 'Usuario inválido. Por favor verifique e intente de nuevo.',
      ErrorClaveAcceso: 'Por favor ingrese la clave que posee para acceder a los servicios de Internet de BanescOnline',
      ErrorClaveAccesoInvalida: 'La Clave introducida no es válida.',
      ErrorDobleClick: 'Su operación está en proceso. Por favor, espere el resultado sin presionar nuevamente el botón Aceptar',
      lblURL: BANESCO_URLS.LOGIN_PAGE,
      lnkSitioSeguro2: "window.open('../Ayudas/sitio_seguro_banesconline.htm','ayuda','width=320,height=220,scrollbars=yes')",
      lnkSitioSeguro: "window.open('../Ayudas/sitio_seguro_banesconline.htm','ayuda','width=320,height=220,scrollbars=yes')",
      lnkCandado: "javascript:selloIrA('mantis');",
      // Try both field name patterns (ASP.NET uses different naming conventions)
      txtUsuario: this.credentials.username,
      'ctl00$cp$ddpControles$txtloginname': this.credentials.username,
      bAceptar: 'Aceptar',
      'ctl00$cp$ddpControles$btnAcceder': 'Aceptar'
    };

    const response = await this.postForm(BANESCO_URLS.LOGIN_IFRAME_FORM, formData);
    
    // Should redirect to AU_ValDNA.aspx (security questions)
    const location = response.headers.get('location');
    
    if (response.status === 302 && location) {
      const nextUrl = new URL(location, BANESCO_URLS.BASE).toString();
      this.log(`   Username submitted, redirecting to: ${nextUrl.split('/').pop()}`);
      return { nextUrl };
    }
    
    // If not a redirect, check the response body for errors or next steps
    const html = await response.text();
    
    // Check if we got an error page
    if (html.includes('error') || html.includes('Error')) {
      this.log(`    Response may contain an error`);
    }
    
    // Try to find the form action for next step
    const formActionMatch = html.match(/action="([^"]+)"/);
    if (formActionMatch) {
      const nextUrl = new URL(formActionMatch[1], BANESCO_URLS.BASE).toString();
      this.log(`   Username submitted, next form at: ${nextUrl.split('/').pop()}`);
      return { nextUrl };
    }
    
    // Default to security questions URL
    this.log(`    No redirect found, defaulting to security questions`);
    return { nextUrl: BANESCO_URLS.SECURITY_QUESTIONS };
  }

  private async submitSecurityQuestions(pageUrl: string): Promise<{ nextUrl: string }> {
    // Load security questions page
    const html = await this.fetchPage(pageUrl);
    const parsed = parseSecurityQuestionsPage(html);
    
    this.log(`   Found ${parsed.questions.length} security questions`);
    
    // Match and answer questions
    const answers: Record<string, string> = {};
    
    for (const question of parsed.questions) {
      const answer = this.findSecurityAnswer(question.questionText);
      if (answer) {
        // Map input IDs to form field names
        const fieldName = this.getSecurityFieldName(question.inputId);
        answers[fieldName] = answer;
        this.log(`   Matched: "${question.questionText.substring(0, 30)}..." → answer provided`);
      }
    }
    
    // Build form data
    const formData: Record<string, string> = {
      ...parsed.formFields,
      huella: buildHuella(),
      txtEjecutar: '',
      PreguntaRespuestaFormato: '^[a-zA-Z0-9 _\\-/¿?¡!,.ñÑáÁéÉÍíóÓúÚ]{1,100}$',
      ValidarVacio: '^$',
      ErrorRespuestas: 'Por favor responda las preguntas de seguridad.',
      ErrorPreguntasDistintas: 'La pregunta seleccionada debe ser diferente a las demás.',
      ErrorPreguntasRespuestasIgualdad: 'Las preguntas y respuestas de seguridad deben ser diferentes.',
      IdePregunta: parsed.allHiddenFields['IdePregunta'] || '',
      ErrorRespuestasIgualdad: 'Las respuestas de seguridad deben ser diferentes.',
      txtBatUsuario: '',
      MaxPreguntaRespuesta: '65',
      ErrorDobleClick: 'Su operación está en proceso. Por favor, espere el resultado sin presionar nuevamente el botón Aceptar',
      IdePregunta2: parsed.allHiddenFields['IdePregunta2'] || '',
      IdePregunta3: parsed.allHiddenFields['IdePregunta3'] || '',
      IdePregunta4: parsed.allHiddenFields['IdePregunta4'] || '',
      ContadorPreguntas: String(parsed.questionCount || parsed.questions.length),
      ...answers,
      bAceptar: 'Aceptar'
    };

    const response = await this.postForm(pageUrl, formData);
    
    // Should redirect to ContrasenaDNA.aspx (password page)
    const location = response.headers.get('location');
    const nextUrl = location 
      ? new URL(location, BANESCO_URLS.BASE).toString()
      : BANESCO_URLS.PASSWORD;
    
    this.log(`   Security questions answered, redirecting to: ${nextUrl.split('/').pop()}`);
    
    return { nextUrl };
  }

  private async submitPassword(pageUrl: string): Promise<{ nextUrl: string }> {
    // Load password page
    const html = await this.fetchPage(pageUrl);
    const parsed = parsePasswordPage(html);
    
    // Build form data (similar structure to username page)
    const formData: Record<string, string> = {
      ...parsed.formFields,
      huella: buildHuella(),
      txtBatUsuario: '',
      ValidarVacio: '^$',
      Hidden1: '',
      ClaveFormato: parsed.allHiddenFields['ClaveFormato'] || '^[a-zA-ZñÑ0-9!#\\$\\%\\?¡¿\\*_\\.-]{8,15}$',
      UsuarioFormato: parsed.allHiddenFields['UsuarioFormato'] || '^[a-zA-Z0-9_.]{4,10}$',
      RangoUsuario: parsed.allHiddenFields['RangoUsuario'] || '6|10',
      RangoClave: parsed.allHiddenFields['RangoClave'] || '8|15',
      ErrorUsuario: 'Por favor indique su Usuario.',
      ErrorUsuarioInvalido: 'Usuario inválido. Por favor verifique e intente de nuevo.',
      ErrorClaveAcceso: 'Por favor ingrese la clave que posee para acceder a los servicios de Internet de BanescOnline',
      ErrorClaveAccesoInvalida: 'La Clave introducida no es válida.',
      ErrorDobleClick: 'Su operación está en proceso. Por favor, espere el resultado sin presionar nuevamente el botón Aceptar',
      lblURL: parsed.allHiddenFields['lblURL'] || BANESCO_URLS.LOGIN_IFRAME_FORM,
      lnkSitioSeguro2: "window.open('../Ayudas/sitio_seguro_banesconline.htm','ayuda','width=320,height=220,scrollbars=yes')",
      lnkSitioSeguro: "window.open('../Ayudas/sitio_seguro_banesconline.htm','ayuda','width=320,height=220,scrollbars=yes')",
      lnkCandado: "javascript:selloIrA('mantis');",
      txtClave: this.credentials.password,
      CBMachine: 'on',
      bAceptar: 'Aceptar'
    };

    const response = await this.postForm(pageUrl, formData);
    
    // After password, we get HTML with JS redirect or need to follow Location
    const location = response.headers.get('location');
    
    // The response might be HTML with a redirect, or a 302
    if (location) {
      const nextUrl = new URL(location, BANESCO_URLS.BASE).toString();
      this.log(`   Password submitted, redirecting to: ${nextUrl.split('/').pop()}`);
      return { nextUrl };
    }
    
    // If no redirect header, the page may contain a meta refresh or JS redirect
    // In practice, we should end up at Default.aspx after following redirects
    this.log(`   Password submitted, navigating to dashboard...`);
    return { nextUrl: BANESCO_URLS.DASHBOARD };
  }

  private async verifyAuthentication(dashboardUrl: string): Promise<{
    isAuthenticated: boolean;
    finalUrl: string;
  }> {
    // Fetch the dashboard page
    const html = await this.fetchPage(dashboardUrl);
    const parsed = parseDashboardPage(html);
    
    if (parsed.isAuthenticated) {
      this.log(`   Authentication verified (found ${parsed.menuLinks.length} menu links)`);
    } else {
      this.log(`   Authentication not verified`);
    }
    
    return {
      isAuthenticated: parsed.isAuthenticated,
      finalUrl: dashboardUrl
    };
  }

  // ==========================================================================
  // Internal: HTTP Helpers
  // ==========================================================================

  private async fetchPage(url: string): Promise<string> {
    const response = await this.makeRequest(url, {
      method: 'GET',
      redirect: 'follow'
    });
    
    return response.text();
  }

  private async postForm(url: string, formData: Record<string, string>): Promise<Response> {
    const response = await this.makeRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(formData).toString(),
      redirect: 'manual' // Handle redirects manually to capture cookies
    });
    
    // If redirected, follow but first capture any new cookies
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // Cookies are already captured in makeRequest
        // Return the response so caller can handle redirect
      }
    }
    
    return response;
  }

  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const headers: HeadersInit = {
      'User-Agent': this.config.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'es-US,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': options.method === 'POST' ? 'iframe' : 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      ...(options.headers || {})
    };
    
    // Add cookies
    if (this.cookies.size > 0) {
      (headers as Record<string, string>)['Cookie'] = serializeCookies(this.cookies);
      this.log(`   [Cookie] Sending: ${serializeCookies(this.cookies).substring(0, 50)}...`);
    }
    
    // Add Referer for all requests (Banesco validates this)
    // Use the authenticated container page as referer for GET, or the request URL for POST
    if (options.method === 'POST') {
      (headers as Record<string, string>)['Origin'] = BANESCO_URLS.BASE;
      (headers as Record<string, string>)['Referer'] = url;
    } else {
      // For GET requests, pretend we're navigating from the authenticated dashboard
      (headers as Record<string, string>)['Referer'] = BANESCO_URLS.LOGIN_PAGE;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      this.log(`   [${options.method || 'GET'}] ${url.substring(url.lastIndexOf('/') + 1)}`);
      
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Capture cookies from response - handle multiple Set-Cookie headers
      // Node.js fetch combines them with ", " but we need to parse carefully
      const setCookieRaw = response.headers.get('set-cookie');
      if (setCookieRaw) {
        // Split by ", " but be careful with expires dates that also contain ", "
        // Each cookie typically starts with a name= pattern
        const cookieParts = setCookieRaw.split(/,(?=[A-Za-z_][A-Za-z0-9_]*=)/);
        for (const part of cookieParts) {
          const newCookies = parseCookies(part.trim());
          newCookies.forEach((value, name) => {
            this.cookies.set(name, value);
            this.log(`   [Cookie] Set: ${name}=${value.substring(0, 20)}...`);
          });
        }
      }
      
      this.log(`   [Response] ${response.status} ${response.statusText}`);
      
      return response;
      
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }
      throw error;
    }
  }

  // ==========================================================================
  // Internal: Security Questions
  // ==========================================================================

  private parseSecurityQuestions(config: string): Map<string, string> {
    const map = new Map<string, string>();
    
    if (!config) return map;
    
    const pairs = config.split(',');
    for (const pair of pairs) {
      const [keyword, answer] = pair.split(':');
      if (keyword && answer) {
        const normalizedKeyword = keyword.trim().toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, ''); // Remove accents
        map.set(normalizedKeyword, answer.trim());
      }
    }
    
    return map;
  }

  private findSecurityAnswer(questionText: string): string | null {
    const normalizedQuestion = questionText.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿?¡!]/g, '');

    for (const [keyword, answer] of this.securityQuestionsMap.entries()) {
      if (normalizedQuestion.includes(keyword)) {
        return answer;
      }
    }
    
    return null;
  }

  private getSecurityFieldName(inputId: string): string {
    // Map simple IDs to ASP.NET form field names
    const mapping: Record<string, string> = {
      'txtPrimeraR': 'txtPrimeraR',
      'txtSegundaR': 'txtSegundaR',
      'txtTerceraR': 'txtTerceraR',
      'txtCuartaR': 'txtCuartaR'
    };
    
    return mapping[inputId] || inputId;
  }

  // ==========================================================================
  // Internal: Transaction Parsing
  // ==========================================================================

  private parseTransactionRows(rows: string[][]): BanescoHttpTransaction[] {
    const transactions: BanescoHttpTransaction[] = [];
    
    for (const row of rows) {
      if (row.length < 3) continue;
      
      try {
        const dateStr = this.findDateInRow(row);
        const amountStr = this.findAmountInRow(row);
        const description = this.findDescriptionInRow(row);
        const dcValue = this.findDCValue(row);
        
        if (!dateStr || !amountStr) continue;
        
        const amount = this.parseAmount(amountStr);
        const type = dcValue === 'D' ? 'debit' : 'credit';
        
        transactions.push({
          date: this.parseDate(dateStr),
          description: description || 'Transacción',
          amount: Math.abs(amount),
          type
        });
        
      } catch {
        continue;
      }
    }
    
    return transactions;
  }

  private findDateInRow(row: string[]): string | null {
    for (const cell of row) {
      if (/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(cell)) {
        return cell;
      }
    }
    return null;
  }

  private findAmountInRow(row: string[]): string | null {
    for (const cell of row) {
      if (/[\d.,]+/.test(cell) && (cell.includes(',') || cell.includes('.'))) {
        return cell;
      }
    }
    return null;
  }

  private findDescriptionInRow(row: string[]): string | null {
    let longestCell = '';
    for (const cell of row) {
      if (cell.length > longestCell.length && 
          !this.findDateInRow([cell]) && 
          !this.findAmountInRow([cell])) {
        longestCell = cell;
      }
    }
    return longestCell || null;
  }

  private findDCValue(row: string[]): string {
    for (const cell of row) {
      if (/^[DC]$/i.test(cell.trim())) {
        return cell.trim().toUpperCase();
      }
    }
    return '';
  }

  private parseAmount(amountString: string): number {
    const cleanAmount = amountString
      .replace(/[^\d,.-]/g, '')
      .replace(/\./g, '')
      .replace(/,/g, '.');
    return parseFloat(cleanAmount) || 0;
  }

  private parseDate(dateString: string): string {
    const cleanDate = dateString.replace(/[^\d/-]/g, '');
    
    if (cleanDate.includes('/')) {
      const parts = cleanDate.split('/');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }
    
    if (cleanDate.includes('-')) {
      const parts = cleanDate.split('-');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }
    
    return dateString;
  }

  // ==========================================================================
  // Internal: Logging
  // ==========================================================================

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BanescoHTTP] ${message}`);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a Banesco HTTP client
 */
export function createBanescoHttpClient(
  credentials: BanescoHttpCredentials,
  config?: BanescoHttpConfig
): BanescoHttpClient {
  return new BanescoHttpClient(credentials, config);
}

/**
 * Quick login function for simple use cases
 */
export async function quickHttpLogin(
  credentials: BanescoHttpCredentials,
  config?: BanescoHttpConfig
): Promise<BanescoHttpLoginResult> {
  const client = createBanescoHttpClient(credentials, config);
  return client.login();
}
