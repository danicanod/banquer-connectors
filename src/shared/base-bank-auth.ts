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
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { 
  PerformanceConfig, 
  getBankPerformanceConfig, 
  getBlockedDomains, 
  isEssentialJS
} from './performance-config.js';

/**
 * Aggregated blocked request statistics (to avoid per-request log spam)
 */
interface BlockedRequestStats {
  total: number;
  byCategory: {
    tracking: number;
    css: number;
    image: number;
    font: number;
    media: number;
    nonEssentialJs: number;
  };
}

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
  
  /** Aggregated blocked request stats (summary logged once on close) */
  private blockedStats: BlockedRequestStats = this.createEmptyBlockedStats();
  private blockedStatsSummaryLogged: boolean = false;

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
      ...config
    } as Required<TConfig>;
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
   * Log a diagnostic message. Silent unless the consumer opted into `debug`.
   *
   * This gating matters for a published library: without it, every login would
   * spam the consumer's stdout AND write a `debug-<bank>-<user>-<ts>.log` file
   * into their working directory as a side effect. Both only happen in debug mode.
   */
  protected log(message: string): void {
    if (!this.config.debug) return;

    console.log(message);

    const logEntry = `[${new Date().toISOString()}] ${message}`;
    try {
      appendFileSync(this.logFile, logEntry + '\n');
    } catch (error) {
      // Fallback if file writing fails
      console.warn('Failed to write to log file:', error);
    }
  }

  /**
   * Create empty blocked request statistics object
   */
  private createEmptyBlockedStats(): BlockedRequestStats {
    return {
      total: 0,
      byCategory: {
        tracking: 0,
        css: 0,
        image: 0,
        font: 0,
        media: 0,
        nonEssentialJs: 0
      }
    };
  }

  /**
   * Reset blocked request statistics (called when initializing new browser)
   */
  private resetBlockedStats(): void {
    this.blockedStats = this.createEmptyBlockedStats();
    this.blockedStatsSummaryLogged = false;
  }

  /**
   * Log the blocked requests summary (called once on close)
   */
  private logBlockedStatsSummary(): void {
    if (this.blockedStatsSummaryLogged || this.blockedStats.total === 0) {
      return;
    }
    
    this.blockedStatsSummaryLogged = true;
    
    const { total, byCategory } = this.blockedStats;
    const parts: string[] = [];
    
    if (byCategory.tracking > 0) parts.push(`tracking=${byCategory.tracking}`);
    if (byCategory.css > 0) parts.push(`css=${byCategory.css}`);
    if (byCategory.image > 0) parts.push(`image=${byCategory.image}`);
    if (byCategory.font > 0) parts.push(`font=${byCategory.font}`);
    if (byCategory.media > 0) parts.push(`media=${byCategory.media}`);
    if (byCategory.nonEssentialJs > 0) parts.push(`js=${byCategory.nonEssentialJs}`);
    
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    this.log(`Blocked resources: ${total}${breakdown}`);
  }

  /**
   * Pause execution for debugging with Playwright debugger
   * Only pauses if debug mode is enabled
   */
  protected async debugPause(message: string): Promise<void> {
    if (this.config.debug && this.page) {
      this.log(`DEBUG PAUSE: ${message}`);
      this.log('Use Playwright Inspector to debug. Continue execution when ready.');
      await this.page.pause();
    }
  }

  /**
   * Wait for element to be ready (visible and enabled) on page
   */
  protected async waitForElementReady(selector: string, timeout: number = 10000): Promise<boolean> {
    if (!this.page) return false;
    
    try {
      // Wait for element to exist
      await this.page.waitForSelector(selector, { timeout });
      
      // Wait for element to be visible and enabled
      await this.page.waitForFunction(
        (sel) => {
          const element = document.querySelector(sel) as HTMLElement;
          return element && 
                 element.offsetParent !== null && // visible
                 !element.hasAttribute('disabled'); // enabled
        },
        selector,
        { timeout }
      );
      
      return true;
    } catch (error) {
      this.log(` Element not ready: ${selector} - ${error}`);
      return false;
    }
  }

  /**
   * Wait for element to be ready (visible and enabled) on frame
   */
  protected async waitForElementReadyOnFrame(frame: Frame, selector: string, timeout: number = 10000): Promise<boolean> {
    try {
      // Wait for element to exist
      await frame.waitForSelector(selector, { timeout });
      
      // Wait for element to be visible and enabled
      await frame.waitForFunction(
        (sel) => {
          const element = document.querySelector(sel) as HTMLElement;
          return element && 
                 element.offsetParent !== null && // visible
                 !element.hasAttribute('disabled'); // enabled
        },
        selector,
        { timeout }
      );
      
      return true;
    } catch (error) {
      this.log(` Element not ready on frame: ${selector} - ${error}`);
      return false;
    }
  }

  /**
   * Wait for navigation completion by checking for new content
   */
  protected async waitForNavigation(expectedSelectors: string[] = [], timeout: number = 15000): Promise<boolean> {
    if (!this.page) return false;
    
    try {
      this.log('Waiting for navigation to complete...');
      
      // First try immediate check - maybe elements are already there
      for (const selector of expectedSelectors) {
        try {
          const element = await this.page.$(selector);
          if (element && await element.isVisible()) {
            this.log(`Navigation detected: found ${selector} immediately`);
            return true;
          }
        } catch {
          // Continue checking
        }
      }
      
      // If not immediate, wait for any of the expected selectors to appear
      if (expectedSelectors.length > 0) {
        this.log(`Waiting for any of: ${expectedSelectors.join(', ')}`);
        
        try {
          await Promise.race(
            expectedSelectors.map(selector => 
              this.page!.waitForSelector(selector, { timeout })
            )
          );
          this.log('Navigation detected: new content appeared');
          return true;
        } catch (raceError) {
          this.log(` None of expected elements appeared: ${raceError}`);
        }
      }
      
      // Fallback: wait for load state change
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 5000 });
        this.log('Navigation completed: network idle');
        return true;
      } catch (loadError) {
        this.log(` Load state timeout: ${loadError}`);
      }
      
      this.log('Navigation assumed successful - continuing');
      return true;
      
    } catch (error) {
      this.log(` Navigation timeout: ${error}`);
      return false;
    }
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
      
      // For POST requests to Banesco, add Origin header if missing
      // Real browsers always send Origin on form submissions
      // NOTE: We only ADD headers, don't replace the entire headers object to preserve cookies
      if (method === 'POST' && url.includes('banesconline.com')) {
        const existingHeaders = request.headers();
        const additionalHeaders: Record<string, string> = {};
        
        // Log POST interception
        this.log(`INTERCEPTED POST: ${url.substring(0, 60)}...`);
        this.log(`   Existing Origin: ${existingHeaders['origin'] || 'NONE'}`);
        
        if (!existingHeaders['origin']) {
          additionalHeaders['origin'] = 'https://www.banesconline.com';
          this.log(`   Adding Origin: https://www.banesconline.com`);
        }
        // Also ensure Sec-Fetch headers are present (modern Chrome sends these)
        if (!existingHeaders['sec-fetch-site']) {
          additionalHeaders['sec-fetch-site'] = 'same-origin';
          additionalHeaders['sec-fetch-mode'] = 'navigate';
          additionalHeaders['sec-fetch-dest'] = 'document';
          this.log(`   Adding Sec-Fetch headers`);
        }
        
        // Only modify if we have additional headers to add
        if (Object.keys(additionalHeaders).length > 0) {
          this.log(`   Continuing with modified headers`);
          await route.continue({ headers: { ...existingHeaders, ...additionalHeaders } });
          return;
        }
      }
      
      // Check if URL contains blocked domains
      const shouldBlockDomain = blockedDomains.some(domain => url.includes(domain));
      
      if (shouldBlockDomain) {
        this.blockedStats.total++;
        this.blockedStats.byCategory.tracking++;
        await route.abort();
        return;
      }
      
      // Block by resource type
      if (this.performanceConfig.blockCSS && resourceType === 'stylesheet') {
        this.blockedStats.total++;
        this.blockedStats.byCategory.css++;
        await route.abort();
        return;
      }
      
      if (this.performanceConfig.blockImages && resourceType === 'image') {
        this.blockedStats.total++;
        this.blockedStats.byCategory.image++;
        await route.abort();
        return;
      }
      
      if (this.performanceConfig.blockFonts && resourceType === 'font') {
        this.blockedStats.total++;
        this.blockedStats.byCategory.font++;
        await route.abort();
        return;
      }
      
      if (this.performanceConfig.blockMedia && (resourceType === 'media' || resourceType === 'websocket')) {
        this.blockedStats.total++;
        this.blockedStats.byCategory.media++;
        await route.abort();
        return;
      }
      
      // Block non-essential JavaScript using intelligent detection
      if (this.performanceConfig.blockNonEssentialJS && resourceType === 'script') {
        if (!isEssentialJS(url, this.bankName)) {
          this.blockedStats.total++;
          this.blockedStats.byCategory.nonEssentialJs++;
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
    this.resetBlockedStats();

    // Realistic browser headers, shared by both local and remote modes.
    // In local mode these go into newContext(); in remote mode they are the
    // only context option we can still set after attaching.
    const extraHTTPHeaders = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'es-VE,es-419;q=0.9,es;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };

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
    
    await context.addInitScript(() => {
      // Override navigator.webdriver - most common bot detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
      
      // Override navigator.plugins to look like a real browser
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
          ];
          // Make it array-like with length
          const pluginArray = Object.create(PluginArray.prototype);
          plugins.forEach((p, i) => {
            pluginArray[i] = p;
          });
          Object.defineProperty(pluginArray, 'length', { value: plugins.length });
          return pluginArray;
        },
        configurable: true
      });
      
      // Override navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['es-VE', 'es-419', 'es', 'en'],
        configurable: true
      });
      
      // Override navigator.platform to match Windows user agent
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
        configurable: true
      });
      
      // Override navigator.hardwareConcurrency (realistic value)
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true
      });
      
      // Override navigator.deviceMemory (realistic value)
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true
      });
      
      // Override chrome runtime to look like real Chrome
      // Use unknown cast to safely assign to window.chrome (browser-specific global)
      const chromeShim = {
        runtime: {
          connect: () => {},
          sendMessage: () => {},
          onMessage: { addListener: () => {} }
        },
        loadTimes: () => ({}),
        csi: () => ({})
      };
      (window as unknown as { chrome: typeof chromeShim }).chrome = chromeShim;
      
      // Override permissions API
      const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (originalQuery) {
        const permissions = navigator.permissions as Permissions & {
          query: (desc: PermissionDescriptor) => Promise<PermissionStatus>;
        };
        permissions.query = (parameters: PermissionDescriptor) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
          }
          return originalQuery(parameters);
        };
      }
      
      // Make toString() on functions look native
      const originalFunction = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === Function.prototype.toString) {
          return 'function toString() { [native code] }';
        }
        return originalFunction.call(this);
      };
    });
    
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
    try {
      if (existsSync(this.logFile)) {
        return readFileSync(this.logFile, 'utf-8');
      }
      return 'Log file not found';
    } catch (error) {
      return `Error reading log file: ${error}`;
    }
  }

  /**
   * Export logs to a specific file
   */
  exportLogs(targetPath: string): boolean {
    try {
      const content = this.getLogContent();
      writeFileSync(targetPath, content);
      this.log(`Logs exported to: ${targetPath}`);
      return true;
    } catch (error) {
      this.log(`Failed to export logs: ${error}`);
      return false;
    }
  }

  /**
   * Close browser and cleanup resources
   */
  async close(): Promise<void> {
    try {
      // Log blocked resources summary before closing
      this.logBlockedStatsSummary();
      
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