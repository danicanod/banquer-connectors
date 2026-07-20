/**
 * Banesco Authentication with Playwright
 * 
 * This module provides authentication functionality for Banesco online banking
 * using the abstract BaseBankAuth class with Banesco-specific implementation
 * of security questions, iframe handling, and modal management.
 */
import { SecurityQuestionsHandler, SecurityQuestionsResult } from './security-questions.js';
import { BaseBankAuth } from '../../../shared/base-bank-auth.js';
import { Frame } from 'playwright';
import {
  BanescoCredentials,
  BanescoLoginResult,
  BanescoAuthConfig,
  BANESCO_URLS
} from '../types/index.js';
import {
  verifyLoginSuccess as verifyBanescoLogin,
  checkForBanescoErrorPage as checkBanescoErrorPage,
  type BanescoErrorDetails,
} from './login-verifier.js';

// Re-exported for back-compat; the type and the verification logic now live in
// ./login-verifier.
export type { BanescoErrorDetails };

/** The distinct screens the Banesco login flow can be on (see `LOGIN_STEP`). */
type LoginStep =
  | 'unknown'
  | 'active_session_warning'
  | 'security_questions'
  | 'password'
  | 'login_form';

export class BanescoAuth extends BaseBankAuth<
  BanescoCredentials, 
  BanescoAuthConfig, 
  BanescoLoginResult
> {
  private securityHandler: SecurityQuestionsHandler;
  
  /** Stores the last detected Banesco error details (if any) */
  private lastBanescoError: BanescoErrorDetails | null = null;

  /** The specific reason performLogin failed, surfaced to the caller instead of a generic failure. */
  private lastLoginError: Error | null = null;

  constructor(credentials: BanescoCredentials, config: BanescoAuthConfig = {}) {
    super('Banesco', credentials, config);
    
    this.securityHandler = new SecurityQuestionsHandler(
      credentials.securityQuestions,
      this.config.debug
    );
  }

  /**
   * Get default configuration with Banesco-specific defaults
   */
  protected getDefaultConfig(config: BanescoAuthConfig): Required<BanescoAuthConfig> {
    const merged = {
      headless: false,
      timeout: 30000,
      debug: false,
      saveSession: true,
      pauseOnDebug: true,
      loginRetries: parseInt(process.env.BANESCO_LOGIN_RETRIES || '0', 10),
      loginRetryDelayMs: parseInt(process.env.BANESCO_LOGIN_RETRY_DELAY_MS || '5000', 10),
      ...config
    } as Required<BanescoAuthConfig>;

    // In remote (CDP) mode the in-SDK retry cannot work: close() ends the
    // remote session and a Browserbase connectUrl is single-use, so a reconnect
    // would hit a dead endpoint. Creating a fresh session per attempt is the
    // caller's responsibility.
    if (merged.browserWSEndpoint) {
      merged.loginRetries = 0;
    }

    return merged;
  }

  /**
   * Get user identifier for logging (safe/truncated)
   */
  protected getUserIdentifier(): string {
    return this.credentials.username.substring(0, 3);
  }

  /**
   * Override login to add retry logic for transient Banesco outages
   */
  async login(): Promise<BanescoLoginResult> {
    const maxAttempts = (this.config.loginRetries || 0) + 1;
    const retryDelay = this.config.loginRetryDelayMs || 5000;
    
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          this.log(`Retry attempt ${attempt}/${maxAttempts} after transient error...`);
        }
        
        // Call the parent login method
        const result = await super.login();
        return result;
        
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        
        // Check if this is a transient outage that we should retry
        const banescoError = this.getLastBanescoError();
        const isTransient = banescoError?.isTransientOutage || 
          (errorMessage && (
            errorMessage.includes('temporarily unavailable') ||
            errorMessage.includes('intente más tarde') ||
            errorMessage.includes('intente mas tarde')
          ));
        
        if (isTransient && attempt < maxAttempts) {
          this.log(`Transient Banesco outage detected. Waiting ${retryDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          
          // Close and reinitialize browser for fresh attempt
          await this.close();
          continue;
        }
        
        // Not a transient error or no more retries - fail
        throw lastError;
      }
    }
    
    // Should not reach here, but just in case
    if (lastError) {
      throw lastError;
    }
    
    return this.createFailureResult('Login failed after all retry attempts');
  }

  /**
   * Get the Banesco login URL
   */
  protected getLoginUrl(): string {
    return BANESCO_URLS.LOGIN;
  }

  /**
   * Banesco form POSTs are rejected by the WAF unless they carry a real
   * browser's Origin / Sec-Fetch-* headers. Playwright omits Origin on some
   * intercepted POSTs, so we add the missing ones here (merged, never replacing
   * the header object, so cookies survive). Only applies to banesconline.com.
   */
  protected getExtraRequestHeaders(
    url: string,
    method: string,
    existingHeaders: Record<string, string>,
  ): Record<string, string> {
    if (method !== 'POST' || !url.includes('banesconline.com')) return {};

    const additionalHeaders: Record<string, string> = {};
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

    return additionalHeaders;
  }

  /**
   * Perform Banesco-specific login with iframe handling
   */
  protected async performBankSpecificLogin(): Promise<boolean> {
    try {
      // Wait for the login iframe to be available
      this.log('Waiting for login iframe...');
      const frame = await this.waitForLoginIframe();
      
      if (!frame) {
        throw new Error('Could not access login iframe');
      }

      await this.debugPause('Login iframe ready - ready to start authentication');

      // Perform the login process within the iframe
      const loginSuccess = await this.performLogin(frame);

      if (loginSuccess) {
        if (!this.page) throw new Error('Browser page not initialized');
        const verification = await verifyBanescoLogin(this.page, (m) => this.log(m));
        this.lastBanescoError = verification.error;
        const verified = verification.success;

        if (!verified) {
          // Check if we have a specific Banesco error to report
          const banescoError = this.getLastBanescoError();
          if (banescoError) {
            const errorInfo = banescoError.errorCode 
              ? `${banescoError.errorCode}${banescoError.server ? ' / ' + banescoError.server : ''}`
              : '';
            const prefix = banescoError.isTransientOutage 
              ? 'Banesco temporarily unavailable' 
              : 'Banesco error';
            throw new Error(`${prefix}${errorInfo ? ` (${errorInfo})` : ''}: ${banescoError.message}`);
          }
          throw new Error('Login verification failed - could not confirm authentication');
        }
        
        return true;
      }
      
      // Login process itself failed - check for Banesco error page
      const banescoError = this.page
        ? await checkBanescoErrorPage(this.page, (m) => this.log(m))
        : null;
      if (banescoError) {
        this.lastBanescoError = banescoError;
        const errorInfo = banescoError.errorCode 
          ? `${banescoError.errorCode}${banescoError.server ? ' / ' + banescoError.server : ''}`
          : '';
        const prefix = banescoError.isTransientOutage 
          ? 'Banesco temporarily unavailable' 
          : 'Banesco error';
        throw new Error(`${prefix}${errorInfo ? ` (${errorInfo})` : ''}: ${banescoError.message}`);
      }

      // No Banesco error page, but performLogin failed for a specific reason
      // (e.g. incomplete security questions) — surface it rather than a generic failure.
      if (this.lastLoginError) {
        throw this.lastLoginError;
      }

      return false;

    } catch (error) {
      this.log(`Bank-specific login failed: ${error}`);
      throw error; // Re-throw to propagate the detailed error message
    }
  }

  /**
   * Wait for the login iframe to be available
   */
  private async waitForLoginIframe(): Promise<Frame | null> {
    if (!this.page) return null;

    try {
      // Wait for iframe element
      await this.page.waitForSelector(BANESCO_URLS.IFRAME_SELECTOR, {
        timeout: this.config.timeout
      });

      // Get the iframe
      const iframeElement = await this.page.$(BANESCO_URLS.IFRAME_SELECTOR);
      if (!iframeElement) {
        throw new Error('Iframe element not found');
      }

      // Get the frame content
      const frame = await iframeElement.contentFrame();
      if (!frame) {
        throw new Error('Could not access iframe content');
      }

      // Wait for frame to be ready
      await frame.waitForLoadState('domcontentloaded');
      
      // Wait for any known username input to be visible (fast multi-selector check)
      const usernameSelectors = [
        '#ctl00_cp_ddpControles_txtloginname',
        'input[name="txtUsuario"]',
        'input[id*="txtUsuario"]',
        'input[id*="txtloginname"]',
        'input[type="text"]',
      ];
      
      let usernameFieldFound = false;
      for (const sel of usernameSelectors) {
        try {
          await frame.waitForSelector(sel, { timeout: 2500, state: 'visible' });
          this.log(`Username field detected: ${sel}`);
          usernameFieldFound = true;
          break;
        } catch {
          // Try next selector
        }
      }
      
      if (!usernameFieldFound) {
        // Log for debugging but don't fail - enterUsernameAndSubmit has its own lookup
        const frameContent = await frame.content();
        const hasForm = frameContent.includes('txtloginname') || frameContent.includes('txtUsuario');
        this.log(`Username field not found via fast check. Form elements in HTML: ${hasForm}`);
      }
      
      this.log('Login iframe ready');
      return frame;

    } catch (error) {
      this.log(`Failed to access login iframe: ${error}`);
      return null;
    }
  }

  /**
   * Detected step in the login flow
   */
  private static readonly LOGIN_STEP = {
    UNKNOWN: 'unknown',
    ACTIVE_SESSION_WARNING: 'active_session_warning',
    SECURITY_QUESTIONS: 'security_questions',
    PASSWORD: 'password',
    LOGIN_FORM: 'login_form',
  } as const;

  private async detectCurrentStep(frame: Frame): Promise<LoginStep> {
    // FIRST: Check URL for AU_ValDNA.aspx - this is definitively the security questions page
    // This check takes priority because AU_ValDNA can sometimes have password-like fields
    // that cause false positives when checking password selectors first
    try {
      const frameUrl = frame.url();
      if (frameUrl.includes('AU_ValDNA.aspx')) {
        this.log('Detected AU_ValDNA.aspx URL - this is security questions page');
        return BanescoAuth.LOGIN_STEP.SECURITY_QUESTIONS;
      }
    } catch { /* continue */ }

    // Check for security questions labels BEFORE password field
    // This ensures we don't skip security questions when both are somehow visible
    const securityLabelSelectors = [
      '#lblPrimeraP',
      '#lblSegundaP',
      '#lblTerceraP',
      '#lblCuartaP',
      '[id$="lblPrimeraP"]',
      '[id$="lblSegundaP"]',
      'label[id*="Pregunta"]',
      'span[id*="Pregunta"]'
    ];
    for (const sel of securityLabelSelectors) {
      try {
        const el = await frame.$(sel);
        if (el && await el.isVisible()) {
          return BanescoAuth.LOGIN_STEP.SECURITY_QUESTIONS;
        }
      } catch { /* continue */ }
    }

    // Check for password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[id*="txtclave"]',
      'input[id*="txtClave"]',
      '#ctl00_cp_ddpControles_txtclave'
    ];
    for (const sel of passwordSelectors) {
      try {
        const el = await frame.$(sel);
        if (el && await el.isVisible()) {
          return BanescoAuth.LOGIN_STEP.PASSWORD;
        }
      } catch { /* continue */ }
    }

    // Check for login form (username field visible = we're back at login page)
    // This must come BEFORE the loose text-based checks to avoid false positives
    // (the login page contains "preguntas de seguridad" in help links)
    const usernameSelectors = [
      'input[id*="txtUsuario"]',
      'input[id*="txtloginname"]',
      '#ctl00_cp_ddpControles_txtloginname',
    ];
    for (const sel of usernameSelectors) {
      try {
        const el = await frame.$(sel);
        if (el && await el.isVisible()) {
          this.log('Detected login form (username field visible)');
          return BanescoAuth.LOGIN_STEP.LOGIN_FORM;
        }
      } catch { /* continue */ }
    }

    // Check page content for active session warning
    try {
      const content = await frame.content();
      const text = content.toLowerCase();
      if (
        text.includes('conexión activa') ||
        text.includes('sesión abierta') ||
        (text.includes('hemos detectado') && text.includes('conexión'))
      ) {
        return BanescoAuth.LOGIN_STEP.ACTIVE_SESSION_WARNING;
      }
      // Only match actual security questions page: must have answer input fields
      // (not just the help text "¿Olvidó su ... preguntas de seguridad?")
      if (
        (text.includes('pregunta') && text.includes('seguridad')) &&
        (text.includes('txtprimerar') || text.includes('txtsegundar') || text.includes('respuesta'))
      ) {
        return BanescoAuth.LOGIN_STEP.SECURITY_QUESTIONS;
      }
    } catch { /* continue */ }

    return BanescoAuth.LOGIN_STEP.UNKNOWN;
  }

  /**
   * Perform the login process within the iframe
   * Banesco has a multi-step flow:
   * Step 1: Username → Click Aceptar
   * Step 2: Security questions (if shown) → Click Aceptar  
   * Step 3: Password → Click Aceptar
   * 
   * Additionally, an "active session" warning can appear at any step.
   * This method loops to handle that warning until we reach password or max retries.
   */
  private async performLogin(frame: Frame): Promise<boolean> {
    this.log('Starting login process...');
    this.lastLoginError = null;

    try {
      // Step 1: Enter username and submit
      this.log('Step 1: Entering username...');
      await this.enterUsernameAndSubmit(frame);
      
      await this.debugPause('Username submitted - waiting for next step');

      // Step 2: Wait for next step and get fresh frame reference
      this.log('Waiting for next step to load...');
      await this.page?.waitForTimeout(3000);

      // Loop to handle intermediate screens (active session warning, security questions).
      // The budget must cover a full re-login cycle in case the password submit lands on
      // the post-password active-session warning (see the PASSWORD branch below).
      const MAX_RETRIES = 12;
      let currentFrame = await this.getRefreshedFrame();

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (!currentFrame) {
          throw new Error('Lost iframe during login flow');
        }

        const step = await this.detectCurrentStep(currentFrame);
        this.log(`Detected step: ${step} (attempt ${attempt + 1}/${MAX_RETRIES})`);

        if (step === BanescoAuth.LOGIN_STEP.PASSWORD) {
          // Found password field - proceed to enter password
          this.log('Step 3: Entering password...');
          await this.enterPasswordDirect(currentFrame);

          // Do NOT assume the password submit finished the login. Banesco frequently
          // answers the password postback with the "existe una conexión activa" warning
          // (another session is open) instead of the dashboard — common because the
          // caller never logs out, so a previous run's session lingers. Re-inspect the
          // page: if it's the active-session warning or a bounce back to the login form,
          // keep looping so the ACTIVE_SESSION_WARNING / LOGIN_FORM handlers dismiss it
          // and re-authenticate. Only treat login as submitted once we're past those.
          await this.page?.waitForTimeout(3000);
          currentFrame = await this.getRefreshedFrame();
          const postStep = currentFrame
            ? await this.detectCurrentStep(currentFrame)
            : BanescoAuth.LOGIN_STEP.UNKNOWN;
          if (
            postStep === BanescoAuth.LOGIN_STEP.ACTIVE_SESSION_WARNING ||
            postStep === BanescoAuth.LOGIN_STEP.LOGIN_FORM ||
            postStep === BanescoAuth.LOGIN_STEP.SECURITY_QUESTIONS
          ) {
            this.log(`Post-password screen is "${postStep}" (likely active-session); resolving before finishing...`);
            continue;
          }

          this.log('Login form submitted successfully');
          return true;
        }

        if (step === BanescoAuth.LOGIN_STEP.SECURITY_QUESTIONS) {
          this.log('Step 2: Handling security questions...');
          const result: SecurityQuestionsResult = await this.securityHandler.handleSecurityQuestions(currentFrame);
          
          this.log(`Security questions: ${result.answersProvided}/${result.questionsFound} answered`);
          
          // Banesco typically requires 2 answers. Don't require \"all\" because the page can contain extra slots.
          if (result.meetsMinimum) {
            this.log(`Security questions answered (>= ${result.minimumRequiredAnswers}), submitting...`);
            await this.clickSubmitButton(currentFrame);
            await this.page?.waitForTimeout(2000);
            currentFrame = await this.getRefreshedFrame();
            continue;
          } else if (result.questionsFound === 0) {
            // No questions found - might be a detection issue, try to continue
            this.log('No security questions found on page, attempting to continue...');
            await this.clickSubmitButton(currentFrame);
            await this.page?.waitForTimeout(2000);
            currentFrame = await this.getRefreshedFrame();
            continue;
          } else {
            // Some questions found but not all answered - fail fast with clear error
            const failedDetails = result.details
              .filter(d => d.status !== 'answered')
              .map(d => `${d.labelId}: ${d.status}`)
              .join(', ');
            throw new Error(
              `Security questions incomplete: answered ${result.answersProvided}/${result.questionsFound} ` +
              `(minRequired=${result.minimumRequiredAnswers}). ` +
              `Failed: ${failedDetails}. ` +
              `Check BANESCO_SECURITY_QUESTIONS env var has keywords matching all questions.`
            );
          }
        }

        if (step === BanescoAuth.LOGIN_STEP.ACTIVE_SESSION_WARNING) {
          this.log('Active session warning detected, clicking Aceptar to continue...');
          await this.clickSubmitButton(currentFrame);
          await this.page?.waitForTimeout(3000);
          currentFrame = await this.getRefreshedFrame();
          continue;
        }

        if (step === BanescoAuth.LOGIN_STEP.LOGIN_FORM) {
          this.log('Back at login form, re-entering username...');
          await this.enterUsernameAndSubmit(currentFrame);
          await this.page?.waitForTimeout(3000);
          currentFrame = await this.getRefreshedFrame();
          continue;
        }

        // UNKNOWN step - wait a bit and try again
        this.log('Unknown step, waiting for page to settle...');
        await this.page?.waitForTimeout(2000);
        currentFrame = await this.getRefreshedFrame();
      }

      throw new Error('Max retries exceeded - could not reach password step');

    } catch (error) {
      // Preserve the specific reason (e.g. "Security questions incomplete: ...") so
      // performBankSpecificLogin can surface it instead of a generic failure.
      this.lastLoginError = error instanceof Error ? error : new Error(String(error));
      this.log(`Login process failed: ${this.lastLoginError.message}`);
      return false;
    }
  }

  /**
   * Enter password directly (assumes password field is visible)
   */
  private async enterPasswordDirect(frame: Frame): Promise<void> {
    const passwordSelectors = [
      'input[type="password"]',
      'input[id*="txtclave"]',
      'input[id*="txtClave"]',
      '#ctl00_cp_ddpControles_txtclave'
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        const element = await frame.$(selector);
        if (element && await element.isVisible()) {
          passwordField = element;
          this.log(`Found password field: ${selector}`);
          break;
        }
      } catch { continue; }
    }

    if (!passwordField) {
      throw new Error('Password field not found');
    }

    // Human-like: click field first, small delay, then type with delays
    await passwordField.click();
    await this.humanDelay(200, 400);
    
    // Type like a human (character by character with small delays)
    await passwordField.type(this.credentials.password, { delay: 50 });
    this.log('Password entered');

    // Human-like delay before submitting
    await this.humanDelay(500, 1000);

    // Submit via the Aceptar button so the ASP.NET postback carries the button's event
    // target — the same mechanism the username and security-questions steps use. Pressing
    // Enter submits the form without that postback, which on ContrasenaDNA.aspx can leave
    // the flow stuck on the password page. Fall back to Enter if no submit button exists.
    try {
      await this.clickSubmitButton(frame);
      this.log('Submit triggered via Aceptar click');
    } catch (e) {
      this.log(`Aceptar button not found (${e instanceof Error ? e.message : e}); falling back to Enter`);
      await passwordField.press('Enter');
      this.log('Submit triggered via Enter');
    }
  }
  
  /**
   * Add a random human-like delay
   */
  private async humanDelay(minMs: number, maxMs: number): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    await this.page?.waitForTimeout(delay);
  }

  /**
   * Get a fresh reference to the iframe (it may reload between steps)
   */
  private async getRefreshedFrame(): Promise<Frame | null> {
    if (!this.page) return null;
    
    try {
      const iframeElement = await this.page.$(BANESCO_URLS.IFRAME_SELECTOR);
      if (!iframeElement) return null;
      
      const frame = await iframeElement.contentFrame();
      if (frame) {
        await frame.waitForLoadState('domcontentloaded').catch(() => {});
      }
      return frame;
    } catch {
      return null;
    }
  }

  /**
   * Enter username and click submit button (Step 1)
   */
  private async enterUsernameAndSubmit(frame: Frame): Promise<void> {
    // Find and fill username
    const usernameSelectors = [
      'input[id*="txtUsuario"]',
      'input[id*="txtloginname"]',
      '#ctl00_cp_ddpControles_txtloginname',
      'input[type="text"]'
    ];
    
    this.log('Looking for username field...');
    
    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        const element = await frame.$(selector);
        if (element && await element.isVisible()) {
          usernameField = element;
          this.log(`Found username field: ${selector}`);
          break;
        }
      } catch { continue; }
    }
    
    if (!usernameField) {
      throw new Error('Username field not found');
    }
    
    // Human-like: click field first, small delay, then type with delays
    await usernameField.click();
    await this.humanDelay(200, 400);
    
    // Type like a human (character by character with small delays)
    await usernameField.type(this.credentials.username, { delay: 50 });
    this.log('Username entered');
    
    // Human-like delay before submitting
    await this.humanDelay(300, 600);
    
    // Use button click for username step (Enter might not work on all forms)
    await this.clickSubmitButton(frame);
  }


  /**
   * Click the submit/Aceptar button
   */
  private async clickSubmitButton(frame: Frame): Promise<void> {
    const submitSelectors = [
      'input[value="Aceptar"]',
      'input[id*="btnAcceder"]',
      '#ctl00_cp_ddpControles_btnAcceder',
      'input[type="submit"]',
      'button[type="submit"]'
    ];
    
    for (const selector of submitSelectors) {
      try {
        const element = await frame.$(selector);
        if (element && await element.isVisible()) {
          this.log(`Clicking submit: ${selector}`);
          await element.click();
          this.log('Submit clicked');
          return;
        }
      } catch { continue; }
    }
    
    throw new Error('Submit button not found');
  }

  /**
   * Get the last detected Banesco error details (if any)
   */
  getLastBanescoError(): BanescoErrorDetails | null {
    return this.lastBanescoError;
  }

  /**
   * Create Banesco-specific success result
   */
  protected createSuccessResult(): BanescoLoginResult {
    return {
      success: true,
      message: 'Authentication successful',
      sessionValid: true,
      systemMessage: 'Banesco online banking session established'
    };
  }

  /**
   * Create Banesco-specific failure result
   */
  protected createFailureResult(message: string): BanescoLoginResult {
    return {
      success: false,
      message,
      sessionValid: false,
      error: message,
      systemMessage: 'Authentication failed'
    };
  }

  /**
   * Get credentials for logging purposes (safe)
   */
  getCredentials(): { username: string } {
    return { username: this.credentials.username };
  }
} 