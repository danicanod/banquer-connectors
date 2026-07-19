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
  parseTransactionsTable,
  parseAspNetFormFields,
  parseAllHiddenFields,
  findBestTransactionPostBack,
  buildPostBackFormData,
  parseAccountsFromDashboard,
  type PostBackAction
} from './form-parser.js';
import {
  looksLikeLoginContainer,
  isBanescoErrorPage,
  pageSaysNoMovements,
} from './page-classifier.js';
import {
  parseMovementsFromHtml,
  parseTransactionRows,
} from './movements-parser.js';
import { BanescoTransport } from './transport.js';

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
  private config: {
    timeout: number;
    debug: boolean;
    userAgent: string;
    cookies?: Map<string, string> | Record<string, string>;
    skipLogin: boolean;
  };
  private transport: BanescoTransport;
  private isAuthenticated: boolean = false;

  constructor(credentials: BanescoHttpCredentials, config: BanescoHttpConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
      cookies: config.cookies ?? undefined,
      skipLogin: config.skipLogin ?? false
    };

    this.transport = new BanescoTransport(
      {
        userAgent: this.config.userAgent,
        timeout: this.config.timeout,
        baseUrl: BANESCO_URLS.BASE,
        loginPageUrl: BANESCO_URLS.LOGIN_PAGE,
      },
      (m) => this.log(m),
    );

    // Import pre-set cookies if provided
    if (config.cookies) {
      if (config.cookies instanceof Map) {
        config.cookies.forEach((value, name) => this.transport.setCookie(name, value));
      } else {
        Object.entries(config.cookies).forEach(([name, value]) => this.transport.setCookie(name, value));
      }
      this.isAuthenticated = config.skipLogin ?? false;
      this.log(`BanescoHttpClient initialized with ${this.transport.cookieCount} pre-set cookies`);
    } else {
      this.log(`BanescoHttpClient initialized`);
    }

    this.log(`   Username: ${credentials.username.substring(0, 3)}***`);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

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
      const dashboardHtml = await this.transport.fetchPage(BANESCO_URLS.DASHBOARD);

      const { rows, tableFound } = parseTransactionsTable(dashboardHtml);
      if (tableFound && rows.length > 0) {
        const transactions = parseTransactionRows(rows);
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

      const legacyTransactions = parseTransactionRows(parsed.rows);
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
      const response = await this.transport.postForm(BANESCO_URLS.DASHBOARD, formData);
      
      // Handle redirects if needed
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const redirectUrl = new URL(location, BANESCO_URLS.BASE).toString();
          this.log(`   Following redirect to: ${redirectUrl.split('/').pop()}`);
          return await this.transport.fetchPage(redirectUrl);
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
    return this.transport.getCookies();
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
        this.transport.setCookie(cookie.name, cookie.value);
        importedCount++;
        this.log(`   [Cookie] Imported: ${cookie.name}`);
      }
    }
    
    this.isAuthenticated = importedCount > 0;
    this.log(`Imported ${importedCount} cookies from Playwright (${playwrightCookies.length} provided)`);
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
      this.log('Fetching accounts...');

      // Prefer the dedicated accounts page (more stable than Default.aspx in newer layouts)
      let html = await this.transport.fetchPage(BANESCO_URLS.CONSULTAS_CUENTAS);

      // If we hit an error or login container, fall back to the legacy dashboard
      if (isBanescoErrorPage(html) || looksLikeLoginContainer(html)) {
        this.log('   Accounts page looks invalid (error/login). Falling back to legacy dashboard...');
        html = await this.transport.fetchPage(BANESCO_URLS.DASHBOARD);
      }

      // Debug: save HTML if in debug mode
      if (this.config.debug) {
        const fs = await import('fs');
        fs.writeFileSync('debug-banesco-accounts.html', html);
        this.log(`   Saved accounts HTML to debug-banesco-accounts.html (${html.length} chars)`);
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
      const movementsPageHtml = await this.transport.fetchPage(BANESCO_URLS.MOVIMIENTOS_CUENTA);

      if (this.config.debug) {
        const fs = await import('fs');
        fs.writeFileSync('debug-banesco-movements-form.html', movementsPageHtml);
      }

      if (isBanescoErrorPage(movementsPageHtml) || looksLikeLoginContainer(movementsPageHtml)) {
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
        const pageTransactions = parseMovementsFromHtml(currentPageHtml, accountNumber, (m) => this.log(m));
        
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
      
      // The page loaded and the form submitted, but we parsed zero rows AND saw no
      // explicit "no movements" marker (that confident-empty case returns success
      // above). For a financial connector this is ambiguous — likely a parse miss —
      // so report it as a failure rather than a misleading empty success. Callers
      // must not treat this as "no transactions".
      this.log(`   No transactions parsed and no "no movements" marker found`);
      return {
        success: false,
        message: 'Movements page loaded but no transactions could be parsed (and no "no movements" marker was present)',
        accountNumber,
        transactions: [],
        error: 'no_transactions_parsed'
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
      
      this.log(`   Fetching next page (clicking ${btnName})...`);
      
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
      const response = await this.transport.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, formData);
      
      // Handle redirect if needed
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
          this.log(`   Following redirect to: ${absoluteUrl.split('/').pop()}`);
          return await this.transport.fetchPage(absoluteUrl);
        }
      }
      
      const nextHtml = await response.text();
      
      // Verify we got a valid page (not an error page)
      if (isBanescoErrorPage(nextHtml)) {
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

        this.log(`   Posting movements form (rdbRango: ${formatDate(thirtyDaysAgo)} - ${formatDate(today)})`);
        const response = await this.transport.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, formData);

        // Handle redirect if needed
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
            this.log(`   Following redirect to: ${absoluteUrl.split('/').pop()}`);
            return await this.transport.fetchPage(absoluteUrl);
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

        this.log(`   Posting movements form (period=${period.value || 'n/a'})`);
        const response = await this.transport.postForm(BANESCO_URLS.MOVIMIENTOS_CUENTA, attemptForm);
      
        // Handle redirect if needed
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            const absoluteUrl = new URL(location, BANESCO_URLS.BASE).href;
            this.log(`   Following redirect to: ${absoluteUrl.split('/').pop()}`);
            const redirectedHtml = await this.transport.fetchPage(absoluteUrl);
            const txs = parseMovementsFromHtml(redirectedHtml, desiredAccountNumber, (m) => this.log(m));
            if (txs.length > 0) return redirectedHtml;
            if (pageSaysNoMovements(redirectedHtml)) continue;
            // otherwise keep trying other periods
            continue;
          }
        }

        const htmlOut = await response.text();
        const txs = parseMovementsFromHtml(htmlOut, desiredAccountNumber, (m) => this.log(m));
        if (txs.length > 0) return htmlOut;
        if (pageSaysNoMovements(htmlOut)) continue;

        // If we got an error page, stop trying further (likely blocked)
        if (isBanescoErrorPage(htmlOut)) return htmlOut;
      }

      // Return last attempt's result (or null if no attempts)
      return null;
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`   Form submit failed: ${message}`);
      return null;
    }
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
