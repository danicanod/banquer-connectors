/**
 * Abstract Base Bank Authentication Class
 * 
 * This abstract class provides common functionality for all bank authentication
 * implementations, including browser management, logging, error handling, and
 * common configuration patterns.
 * 
 * ## Usage
 * 
 * Extend this class and implement the abstract methods:
 * ```typescript
 * class MyBankAuth extends BaseBankAuth<MyCredentials, MyConfig, MyLoginResult> {
 *   protected getUserIdentifier(): string { return this.credentials.username.slice(0, 3); }
 *   protected getLoginUrl(): string { return 'https://mybank.com/login'; }
 *   protected async performBankSpecificLogin(): Promise<boolean> { ... }
 *   getCredentials(): Record<string, unknown> { return { username: this.credentials.username }; }
 * }
 * ```
 * 
 * ## Features
 * 
 * - **Browser lifecycle**: Automatic Playwright browser init/cleanup
 * - **Stealth mode**: Anti-bot detection measures (navigator overrides, plugin spoofing)
 * - **Performance**: Configurable resource blocking (CSS, images, fonts, tracking)
 * - **Logging**: File-based debug logs with timestamps
 * - **Debug mode**: Playwright Inspector integration for step-through debugging
 * 
 * ## Performance Presets
 * 
 * Configure via `performancePreset` option: 'MAXIMUM', 'AGGRESSIVE', 'BALANCED', 'CONSERVATIVE', 'NONE'
 * 
 * @see {@link PerformanceConfig} for blocking options
 * @see {@link PERFORMANCE_PRESETS} for preset definitions
 */

import { Browser, Page, Frame, chromium, BrowserContext } from 'playwright';
import type { BaseBankAuthConfig, BaseBankLoginResult, BaseBankCredentials } from './types/index.js';
import {
  PerformanceConfig,
  getBankPerformanceConfig,
  getBlockedDomains,
  isEssentialJS
} from './performance-config.js';
import { DebugFileLogger } from './utils/debug-logger.js';
import { BlockedRequestTracker } from './utils/blocked-request-tracker.js';
import { applyStealthMeasures as applyStealthInitScript } from './utils/browser-factory.js';
import {
  waitForElementReady as pageWaitForElementReady,
  waitForElementReadyOnFrame as frameWaitForElementReady,
  waitForNavigation as pageWaitForNavigation,
} from './utils/page-waits.js';

export abstract class BaseBankAuth<
  TCredentials extends BaseBankCredentials,
  TConfig extends BaseBankAuthConfig,
  TLoginResult extends BaseBankLoginResult
> {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected context: BrowserContext | null = null;
  /** True when the browser was attached over CDP (remote) rather than launched locally */
  protected isRemoteBrowser: boolean = false;
  protected credentials: TCredentials;
  protected config: Required<TConfig>;
  protected isAuthenticated: boolean = false;
  protected logFile: string;
  protected bankName: string;
  protected performanceConfig: PerformanceConfig;

  /** File-backed debug logger (silent unless `debug` is enabled). */
  private debugLogger!: DebugFileLogger;
  /** Aggregated blocked request stats (summary logged once on close) */
  private blockedTracker = new BlockedRequestTracker();

  constructor(bankName: string, credentials: TCredentials, config: TConfig) {
    this.bankName = bankName;
    this.credentials = credentials;
    
    // Set up default configuration - subclasses can override specific defaults
    this.config = this.getDefaultConfig(config);
    
    // Get optimized performance configuration for this bank's auth flow
    this.performanceConfig = getBankPerformanceConfig(
      bankName, 
      'auth',
      config.performancePreset
    );
    
    // Allow custom performance overrides
    if (config.performance) {
      this.performanceConfig = { 
        ...this.performanceConfig,
        ...config.performance 
      };
    }
    
    // Setup log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const userIdentifier = this.getUserIdentifier();
    this.logFile = `debug-${bankName.toLowerCase()}-${userIdentifier}-${timestamp}.log`;
    this.debugLogger = new DebugFileLogger(this.logFile, !!this.config.debug);

    this.log(`${bankName} Auth initialized for user: ${this.getUserIdentifier()}***`);
    this.log(`Performance config: CSS:${this.performanceConfig.blockCSS}, IMG:${this.performanceConfig.blockImages}, JS:${this.performanceConfig.blockNonEssentialJS}`);
    
    if (this.config.debug) {
      this.log('Debug mode enabled - Playwright debugger will pause at key points');
    }
  }

  /**
   * Get default configuration with bank-specific overrides
   * Subclasses should override this to provide bank-specific defaults
   */
  protected getDefaultConfig(config: TConfig): Required<TConfig> {
    return {
      headless: false,
      timeout: 30000,
      debug: false,
      saveSession: true,
      pauseOnDebug: true,
      ...config
    } as Required<TConfig>;
  }

  /**
   * Extra HTTP headers applied to the browser context for navigation requests.
   * The default set mimics a real Chrome navigation. Subclasses whose site is a
   * client-rendered SPA (whose XHR template fetches must NOT inherit these fixed
   * `Sec-Fetch-*` values) can override this to return `{}`.
   */
  protected getNavigationHeaders(): Record<string, string> {
    // Deliberately NO Sec-Fetch-* here. These are context-level extraHTTPHeaders, so
    // they are forced onto EVERY request — including the same-origin login form POST,
    // which would then go out with `Sec-Fetch-Site: none` instead of `same-origin`.
    // Banesco's WAF rejects that mismatch (WEBEG001 "no podemos procesar su
    // transacción"), blocking login at the username step; it also defeats the per-POST
    // fixup in getExtraRequestHeaders() (whose `if (!headers['sec-fetch-site'])` guard
    // never fires once these are set). Let the browser compute the correct per-request
    // Sec-Fetch-* values itself. A subclass that truly needs fixed values can add them
    // via getExtraRequestHeaders() where the request method/URL are known.
    return {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'es-VE,es-419;q=0.9,es;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
  }

  /**
   * Per-request header overrides applied during request interception. Called for
   * every request; return a map of headers to ADD (merged over the existing
   * ones), or an empty object to leave the request untouched. The default adds
   * nothing — bank subclasses override this for site-specific needs (e.g. an
   * `Origin`/`Sec-Fetch` fixup on form POSTs) so the base stays bank-agnostic.
   */
  protected getExtraRequestHeaders(
    _url: string,
    _method: string,
    _existingHeaders: Record<string, string>,
  ): Record<string, string> {
    return {};
  }

  /**
   * Get user identifier for logging (should be safe/truncated)
   * Subclasses must implement this to provide safe user identification
   */
  protected abstract getUserIdentifier(): string;

  /**
   * Get the login URL for the bank
   * Subclasses must implement this
   */
  protected abstract getLoginUrl(): string;

  /**
   * Perform the actual login logic specific to each bank
   * Subclasses must implement this with their specific authentication flow
   */
  protected abstract performBankSpecificLogin(): Promise<boolean>;

  /**
   * Log a diagnostic message. Silent unless the consumer opted into `debug`
   * (see {@link DebugFileLogger}); in debug mode it also appends to a per-session
   * log file. Kept `protected` so subclasses can log through the same channel.
   */
  protected log(message: string): void {
    this.debugLogger.log(message);
  }

  /**
   * Pause execution for debugging with Playwright debugger
   * Only pauses if debug mode is enabled
   */
  protected async debugPause(message: string): Promise<void> {
    if (!this.config.debug) return;
    this.log(`DEBUG PAUSE: ${message}`);
    // Attended flows (e.g. Facebank's interactive OTP) set pauseOnDebug=false to
    // keep the checkpoint log without halting on the Playwright Inspector.
    if (this.config.pauseOnDebug && this.page) {
      this.log('Use Playwright Inspector to debug. Continue execution when ready.');
      await this.page.pause();
    }
  }

  /**
   * Wait for element to be ready (visible and enabled) on page
   */
  protected async waitForElementReady(selector: string, timeout: number = 10000): Promise<boolean> {
    if (!this.page) return false;
    return pageWaitForElementReady(this.page, selector, timeout, (m) => this.log(m));
  }

  /**
   * Wait for element to be ready (visible and enabled) on frame
   */
  protected async waitForElementReadyOnFrame(frame: Frame, selector: string, timeout: number = 10000): Promise<boolean> {
    return frameWaitForElementReady(frame, selector, timeout, (m) => this.log(m));
  }

  /**
   * Wait for navigation completion by checking for new content
   */
  protected async waitForNavigation(expectedSelectors: string[] = [], timeout: number = 15000): Promise<boolean> {
    if (!this.page) return false;
    return pageWaitForNavigation(this.page, expectedSelectors, timeout, (m) => this.log(m));
  }

  /**
   * Setup request interception for performance optimizations
   * Also adds missing headers that real browsers send
   */
  protected async setupRequestInterception(page: Page): Promise<void> {
    this.log('Setting up performance optimizations...');
    
    const blockedDomains = getBlockedDomains(this.performanceConfig);
    
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const resourceType = request.resourceType();
      const method = request.method();

      // Allow bank subclasses to inject site-specific headers (e.g. an
      // Origin/Sec-Fetch fixup on form POSTs). We only ADD headers, never
      // replace the whole object, so cookies are preserved. Default: no-op.
      const extraHeaders = this.getExtraRequestHeaders(url, method, request.headers());
      if (Object.keys(extraHeaders).length > 0) {
        await route.continue({ headers: { ...request.headers(), ...extraHeaders } });
        return;
      }

      // Check if URL contains blocked domains
      const shouldBlockDomain = blockedDomains.some(domain => url.includes(domain));
      
      if (shouldBlockDomain) {
        this.blockedTracker.record('tracking');
        await route.abort();
        return;
      }

      // Block by resource type
      if (this.performanceConfig.blockCSS && resourceType === 'stylesheet') {
        this.blockedTracker.record('css');
        await route.abort();
        return;
      }

      if (this.performanceConfig.blockImages && resourceType === 'image') {
        this.blockedTracker.record('image');
        await route.abort();
        return;
      }

      if (this.performanceConfig.blockFonts && resourceType === 'font') {
        this.blockedTracker.record('font');
        await route.abort();
        return;
      }

      if (this.performanceConfig.blockMedia && (resourceType === 'media' || resourceType === 'websocket')) {
        this.blockedTracker.record('media');
        await route.abort();
        return;
      }

      // Block non-essential JavaScript using intelligent detection
      if (this.performanceConfig.blockNonEssentialJS && resourceType === 'script') {
        if (!isEssentialJS(url, this.bankName)) {
          this.blockedTracker.record('nonEssentialJs');
          await route.abort();
          return;
        }
      }
      
      // Allow the request
      await route.continue();
    });
    
    this.log(`Performance optimizations active - ${blockedDomains.length} domains blocked`);
  }

  /**
   * Initialize Playwright browser and page with performance optimizations
   * and stealth measures to avoid bot detection
   */
  protected async initializeBrowser(): Promise<void> {
    this.log('Initializing optimized browser...');

    // Reset blocked stats for new session
    this.blockedTracker.reset();

    // Realistic browser headers, shared by both local and remote modes.
    // In local mode these go into newContext(); in remote mode they are the
    // only context option we can still set after attaching. Subclasses can
    // override getNavigationHeaders() (e.g. an SPA that must NOT inherit them).
    const extraHTTPHeaders = this.getNavigationHeaders();

    if (this.config.browserWSEndpoint) {
      // ---- Remote browser (attach over CDP, e.g. Browserbase) ----
      this.isRemoteBrowser = true;
      this.log('Connecting to remote browser over CDP...');
      this.browser = await chromium.connectOverCDP(this.config.browserWSEndpoint);
      // Reuse the remote session's existing context/page (the Browserbase
      // pattern); only create them if the remote browser started empty.
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      // UA / locale / timezone / viewport are fixed by the remote session and
      // cannot be re-set on an existing context — only headers can.
      await this.context.setExtraHTTPHeaders(extraHTTPHeaders);
    } else {
      // ---- Local browser (launch our own Chromium) ----
      this.isRemoteBrowser = false;

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        // Performance optimizations
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        // STEALTH: Always disable automation detection (not just headless)
        '--disable-blink-features=AutomationControlled',
      ];

      // Add additional performance args if in headless mode
      if (this.config.headless) {
        launchArgs.push(
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--run-all-compositor-stages-before-draw'
        );
      }

      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: launchArgs
      });

      // Use a realistic Windows Chrome user agent (most common)
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      this.context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent,
        locale: 'es-VE',
        timezoneId: 'America/Caracas',
        extraHTTPHeaders,
        // Performance: disable images, CSS, fonts if configured
        // Note: This approach is less granular but very effective
        ...(this.performanceConfig.blockImages && this.performanceConfig.blockCSS ? {
          javaScriptEnabled: true, // Keep JS for functionality
          // Block resources at context level for maximum performance
        } : {})
      });

      this.page = await this.context.newPage();
    }

    // STEALTH: Apply anti-bot detection measures to CONTEXT (affects all pages
    // and iframes). Registered via addInitScript, so it applies on the next
    // navigation in both freshly-launched and reused (remote) contexts.
    await this.applyStealthMeasures(this.context);

    // Setup request interception for fine-grained control
    await this.setupRequestInterception(this.page);
    
    // Set aggressive timeouts for faster failure
    this.page.setDefaultTimeout(this.config.timeout || 30000);
    this.page.setDefaultNavigationTimeout(this.config.timeout || 30000);
    
    // Add network monitoring for debugging bot detection
    if (process.env.SYNC_VERBOSE === 'true') {
      this.setupNetworkMonitoring(this.page);
    }
    
    if (this.config.debug) {
      this.log('Optimized browser initialized in debug mode');
      this.log(`Viewport: 1366x768, Headless: ${this.config.headless}`);
      this.log(` Timeout: ${this.config.timeout}ms`);
      this.log(`Performance optimizations: ${JSON.stringify(this.performanceConfig)}`);
      this.log(`Log file: ${this.logFile}`);
    }
  }

  /**
   * Setup network monitoring for debugging
   */
  private setupNetworkMonitoring(page: Page): void {
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      
      // Monitor CAU/inicio requests (authenticated dashboard)
      if (url.includes('CAU') || url.includes('inicio')) {
        this.log(`${status} ${url.substring(0, 80)}`);
        
        // Check for error responses
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('html') && status === 200) {
          try {
            const body = await response.text();
            if (body.includes('GUEG') || body.includes('no podemos procesar')) {
              this.log(`BOT DETECTION in response: ${url}`);
              // Log request headers that might be the issue
              const request = response.request();
              const headers = request.headers();
              this.log(`   Request headers:`);
              this.log(`   - Referer: ${headers['referer'] || 'MISSING'}`);
              this.log(`   - Origin: ${headers['origin'] || 'MISSING'}`);
              this.log(`   - User-Agent: ${headers['user-agent']?.substring(0, 50) || 'MISSING'}`);
              this.log(`   - Cookie present: ${headers['cookie'] ? 'yes' : 'NO'}`);
            }
          } catch {
            // Ignore body read errors
          }
        }
      }
    });
  }

  /**
   * Apply stealth measures to avoid bot detection
   * Applied to context so it affects ALL pages and iframes
   * This overrides various browser properties that are commonly checked
   */
  protected async applyStealthMeasures(context: BrowserContext): Promise<void> {
    this.log('Applying stealth measures to context (affects all frames)...');
    await applyStealthInitScript(context);
    this.log('Stealth measures applied');
  }

  /**
   * Main login method template - implements common flow
   */
  async login(): Promise<TLoginResult> {
    this.log(`Starting ${this.bankName} authentication process...`);
    
    try {
      // Initialize browser if not already done
      if (!this.browser || !this.page) {
        await this.initializeBrowser();
      }
      
      if (!this.page) {
        throw new Error('Failed to initialize browser page');
      }

      await this.debugPause('Browser initialized - ready to navigate to login page');

      // Navigate to login page
      this.log(`Navigating to ${this.bankName} login page...`);
      await this.page.goto(this.getLoginUrl(), { 
        waitUntil: 'domcontentloaded',
        timeout: this.config.timeout 
      });

      await this.debugPause('Login page loaded - ready to start authentication');

      // Perform bank-specific login
      const loginSuccess = await this.performBankSpecificLogin();
      
      if (loginSuccess) {
        this.isAuthenticated = true;
        this.log(`${this.bankName} authentication successful!`);
        
        await this.debugPause('Login completed successfully - authenticated page ready');
        
        return this.createSuccessResult();
      } else {
        return this.createFailureResult('Authentication failed');
      }

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Authentication error: ${message}`);
      await this.debugPause(`Error occurred: ${message} - inspect page state`);
      return this.createFailureResult(message || 'Unknown error occurred');
    }
  }

  /**
   * Create success result - subclasses can override for additional data
   */
  protected createSuccessResult(): TLoginResult {
    return {
      success: true,
      message: 'Authentication successful',
      sessionValid: true,
    } as TLoginResult;
  }

  /**
   * Create failure result - subclasses can override for additional data
   */
  protected createFailureResult(message: string): TLoginResult {
    return {
      success: false,
      message,
      sessionValid: false,
      error: message
    } as TLoginResult;
  }

  /**
   * Get the authenticated page for further operations
   */
  getPage(): Page | null {
    return this.isAuthenticated ? this.page : null;
  }

  /**
   * Check if currently authenticated
   */
  isLoggedIn(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Get current page URL
   */
  async getCurrentUrl(): Promise<string | null> {
    return this.page ? this.page.url() : null;
  }

  /**
   * Get credentials for logging purposes (should be implemented safely by subclasses)
   */
  abstract getCredentials(): Record<string, unknown>;

  /**
   * Get log file path
   */
  getLogFile(): string {
    return this.logFile;
  }

  /**
   * Get log content
   */
  getLogContent(): string {
    return this.debugLogger.getLogContent();
  }

  /**
   * Export logs to a specific file
   */
  exportLogs(targetPath: string): boolean {
    return this.debugLogger.exportLogs(targetPath);
  }

  /**
   * Close browser and cleanup resources
   */
  async close(): Promise<void> {
    try {
      // Log blocked resources summary before closing
      const blockedSummary = this.blockedTracker.takeSummary();
      if (blockedSummary) this.log(blockedSummary);

      // For a remote (CDP-attached) browser the page and context belong to the
      // remote session — closing them is a no-op at best and can throw. We only
      // disconnect the browser, which ends the remote session (e.g. Browserbase).
      if (!this.isRemoteBrowser) {
        if (this.page) {
          await this.page.close();
          this.page = null;
        }

        if (this.context) {
          await this.context.close();
          this.context = null;
        }
      } else {
        this.page = null;
        this.context = null;
      }

      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }

      this.isAuthenticated = false;
      this.log('Optimized browser resources cleaned up');
      this.log(`Debug session log saved to: ${this.logFile}`);
      
    } catch (error) {
      this.log(` Error during cleanup: ${error}`);
    }
  }
} 