/**
 * Facebank Authentication with Playwright
 *
 * Facebank's online banking is a COBIS CWC Angular single-page app. Login runs
 * client-side (credential encoding, optional captcha, JWT storage), so we drive
 * it with a real browser via the shared BaseBankAuth, then hand the live,
 * authenticated page to the data layer (the app is JWT-based and JS-rendered,
 * so there is no cookie/HTML handoff like Banesco).
 *
 * Flow (confirmed via recon): #!/login (username+password) -> #!/otp (5-char
 * code emailed) -> #!/home. A security-image step-up screen can appear on
 * untrusted devices/IPs but is off the normal path; it is handled defensively.
 */

import { Page } from 'playwright';
import { BaseBankAuth } from '../../../shared/base-bank-auth.js';
import { promptForInput } from '../../../shared/utils/interactive.js';
import {
  FacebankCredentials,
  FacebankAuthConfig,
  FacebankLoginResult,
  FACEBANK_URLS,
  FACEBANK_ROUTES,
  FACEBANK_SELECTORS,
} from '../types/index.js';

type LoginStep = 'login' | 'otp' | 'image' | 'home' | 'unknown';

export class FacebankAuth extends BaseBankAuth<
  FacebankCredentials,
  FacebankAuthConfig,
  FacebankLoginResult
> {
  private imageChallengeSeen = false;

  constructor(credentials: FacebankCredentials, config: FacebankAuthConfig = {}) {
    // COBIS CWC is a heavy Angular SPA that misbehaves under resource blocking,
    // so default to the NONE preset (nothing blocked) — the app then boots exactly
    // as in a normal browser, matching the recon flow. Callers can still override.
    super('Facebank', credentials, { performancePreset: 'NONE', ...config });
  }

  /**
   * The base applies a fixed set of navigation headers (Accept, Sec-Fetch-*,
   * sec-ch-ua, ...) to the browser context. Those break Facebank: the COBIS SPA
   * fetches its Angular templates (which render the login form) over XHR, and
   * those requests would then carry `Sec-Fetch-Site: none` / `Sec-Fetch-Mode:
   * navigate` instead of `same-origin`, so the server rejects them and the page
   * stays blank. Returning no extra headers lets Chromium emit correct
   * per-request values — matching the recon flow that rendered and logged in
   * cleanly. (See also `pauseOnDebug: false`: Facebank login is attended, so the
   * base's Playwright-Inspector pause on debug is disabled rather than overridden.)
   */
  protected getNavigationHeaders(): Record<string, string> {
    return {};
  }

  protected getDefaultConfig(config: FacebankAuthConfig): Required<FacebankAuthConfig> {
    return {
      headless: false, // interactive OTP / manual image fallback want a visible browser
      timeout: 45000,
      debug: false,
      saveSession: true,
      pauseOnDebug: false, // attended login — log debug checkpoints, don't halt
      manualOtp: false,
      manualImageFallback: true,
      ...config,
    } as Required<FacebankAuthConfig>;
  }

  protected getUserIdentifier(): string {
    return this.credentials.username.substring(0, 3);
  }

  protected getLoginUrl(): string {
    return FACEBANK_URLS.LOGIN;
  }

  getCredentials(): { username: string } {
    return { username: this.credentials.username };
  }

  /** Whether the security-image step-up screen was encountered during login. */
  wasImageChallengeSeen(): boolean {
    return this.imageChallengeSeen;
  }

  /**
   * Drive the SPA login: enter credentials, then step through OTP / image
   * screens until we reach the authenticated home route.
   */
  protected async performBankSpecificLogin(): Promise<boolean> {
    const page = this.getPageOrThrow();

    this.log('Waiting for login form to render...');
    const ready = await this.waitForElementReady(FACEBANK_SELECTORS.USERNAME, this.config.timeout);
    if (!ready) {
      throw new Error('Login form did not load (username field not found)');
    }

    // Use fill() (not click+type) so we set the ng-model value without popping
    // the site's virtual keyboard, which is bound to the fields' click handler.
    this.log('Entering credentials...');
    await page.fill(FACEBANK_SELECTORS.USERNAME, this.credentials.username);
    await page.fill(FACEBANK_SELECTORS.PASSWORD, this.credentials.password);
    await page.click(FACEBANK_SELECTORS.LOGIN_BUTTON);
    this.log('Credentials submitted, resolving next step...');

    const MAX_STEPS = 8;
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = await this.detectStep();
      this.log(`Step ${i + 1}/${MAX_STEPS}: ${step}`);

      if (step === 'home') {
        return true;
      }
      if (step === 'otp') {
        await this.handleOtp();
        continue;
      }
      if (step === 'image') {
        this.imageChallengeSeen = true;
        await this.handleImageChallenge();
        continue;
      }
      if (step === 'login') {
        const err = await this.readLoginError();
        if (err) {
          throw new Error(`Facebank login rejected: ${err}`);
        }
      }
      // 'unknown' or a still-settling route: wait and re-check.
      await page.waitForTimeout(2000);
    }

    throw new Error('Login did not reach the home screen within the expected number of steps');
  }

  // --------------------------------------------------------------------------
  // Step handling
  // --------------------------------------------------------------------------

  private async detectStep(): Promise<LoginStep> {
    const page = this.getPageOrThrow();
    // Let the SPA finish routing/rendering after the previous action.
    await page.waitForTimeout(1500);
    const url = page.url().toLowerCase();

    if (url.includes(FACEBANK_ROUTES.HOME)) return 'home';
    if (url.includes(FACEBANK_ROUTES.OTP) || (await this.isVisible(FACEBANK_SELECTORS.OTP_CODE))) {
      return 'otp';
    }
    if (url.includes('imagen') || (await this.hasText('imagen de seguridad'))) {
      return 'image';
    }
    if (await this.isVisible(FACEBANK_SELECTORS.USERNAME)) return 'login';
    return 'unknown';
  }

  private async handleOtp(): Promise<void> {
    const page = this.getPageOrThrow();
    await this.waitForElementReady(FACEBANK_SELECTORS.OTP_CODE, this.config.timeout);

    // Manual OTP mode (headed, attended): the human types the emailed code
    // directly in the browser; we just wait until login advances past the OTP
    // screen. Only used when no otpProvider is supplied.
    if (this.config.manualOtp && !this.config.otpProvider) {
      this.log('Manual OTP mode: enter the emailed code in the browser window...');
      const deadline = Date.now() + 180000; // 3 min for the human
      while (Date.now() < deadline) {
        const url = page.url().toLowerCase();
        if (url.includes(FACEBANK_ROUTES.HOME) || !(await this.isVisible(FACEBANK_SELECTORS.OTP_CODE))) {
          this.log('OTP completed in the browser.');
          await page.waitForTimeout(1500);
          return;
        }
        await page.waitForTimeout(1000);
      }
      throw new Error('Timed out waiting for the OTP to be entered in the browser (3 min)');
    }

    this.log('OTP required — Facebank has emailed a one-time code.');
    const code = this.config.otpProvider
      ? await this.config.otpProvider()
      : await promptForInput('Enter the Facebank 2FA code (sent to your email): ');

    if (!code || !code.trim()) {
      throw new Error('No OTP code was provided');
    }

    await page.fill(FACEBANK_SELECTORS.OTP_CODE, code.trim());
    await page.waitForTimeout(300);
    await page.click(FACEBANK_SELECTORS.OTP_SUBMIT);
    this.log('OTP submitted.');
    await page.waitForTimeout(2500);
  }

  /**
   * The security-image step-up screen is off the normal path and its DOM was
   * not captured, so we do not attempt fragile automated selection. In a headed
   * session we pause for the user to complete it; otherwise we fail with a
   * clear, actionable message.
   */
  private async handleImageChallenge(): Promise<void> {
    const page = this.getPageOrThrow();
    this.log('Security-image challenge detected (off the normal login path).');

    if (this.config.manualImageFallback && !this.config.headless) {
      await promptForInput(
        'Complete the security image + secret word in the browser window, then press Enter to continue...'
      );
      await page.waitForTimeout(1500);
      return;
    }

    throw new Error(
      'Facebank presented the security-image challenge, which cannot be completed ' +
        'automatically. Re-run with headless:false and manualImageFallback:true to ' +
        'handle it manually, or complete a login once so the device becomes trusted.'
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getPageOrThrow(): Page {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }
    return this.page;
  }

  private async isVisible(selector: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      const el = await this.page.$(selector);
      return !!el && (await el.isVisible());
    } catch {
      return false;
    }
  }

  private async hasText(needle: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      const content = await this.page.content();
      return content.toLowerCase().includes(needle.toLowerCase());
    } catch {
      return false;
    }
  }

  private async readLoginError(): Promise<string | null> {
    if (!this.page) return null;
    const selectors = ['.k-notification', '.alert', '.error', '.toast', '[ng-bind*="message"]'];
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el && (await el.isVisible())) {
          const text = (await el.textContent())?.trim();
          if (text) return text;
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }

  protected createSuccessResult(): FacebankLoginResult {
    return {
      success: true,
      message: 'Authentication successful',
      sessionValid: true,
      imageChallengeSeen: this.imageChallengeSeen,
    };
  }

  protected createFailureResult(message: string): FacebankLoginResult {
    return {
      success: false,
      message,
      sessionValid: false,
      error: message,
      imageChallengeSeen: this.imageChallengeSeen,
    };
  }
}
