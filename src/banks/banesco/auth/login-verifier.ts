/**
 * Banesco login verification (extracted from BanescoAuth).
 *
 * These functions inspect the post-submit page/iframe to decide whether login
 * succeeded and to surface a Banesco error page (including transient-outage
 * classification). They take an explicit `page` + `log` and return their result
 * rather than mutating auth state — `verifyLoginSuccess` returns the detected
 * error alongside the boolean instead of writing a `lastBanescoError` field.
 *
 * The pure `isTransientBanescoError` classifier is unit-tested
 * (see tests/banesco-login-verifier.test.ts).
 */

import type { Page } from 'playwright';
import { BANESCO_URLS } from '../types/index.js';

type Logger = (message: string) => void;
const noop: Logger = () => {};

/**
 * Banesco error page details extracted from the login iframe.
 */
export interface BanescoErrorDetails {
  message: string;
  errorCode: string | null;
  server: string | null;
  isTransientOutage: boolean;
}

/** Result of a login-success verification. */
export interface LoginVerification {
  success: boolean;
  /** A Banesco error page detected during verification, if any. */
  error: BanescoErrorDetails | null;
}

/**
 * Pure classifier: is this Banesco error a transient outage worth retrying?
 * (message text mentions "intente más tarde" / "no podemos procesar", or the
 * code is a GU*-style code such as GUEG001).
 */
export function isTransientBanescoError(message: string, errorCode: string | null): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('intente más tarde') ||
    lower.includes('intente mas tarde') ||
    lower.includes('no podemos procesar') ||
    (errorCode?.startsWith('GU') || false) // GUEG001-style codes are often transient
  );
}

/**
 * Inspect the login iframe for a Banesco error page. Returns the extracted
 * details, or null if the page is not an error page.
 */
export async function checkForBanescoErrorPage(
  page: Page,
  log: Logger = noop,
): Promise<BanescoErrorDetails | null> {
  try {
    // Get the login iframe
    const iframeElement = await page.$(BANESCO_URLS.IFRAME_SELECTOR);
    if (!iframeElement) return null;

    const frame = await iframeElement.contentFrame();
    if (!frame) return null;

    const frameContent = await frame.content();

    // Check for error page markers
    const hasErrorMessage = frameContent.includes('lblMensaje');
    const hasErrorCode = frameContent.includes('lblCodigoError');

    if (!hasErrorMessage && !hasErrorCode) {
      return null;
    }

    // Extract error details
    let message = '';
    let errorCode: string | null = null;
    let server: string | null = null;

    // Extract message from lblMensaje
    try {
      const msgElement = await frame.$('#lblMensaje');
      if (msgElement) {
        message = (await msgElement.textContent())?.trim() || '';
      }
    } catch { /* ignore */ }

    // Extract error code from lblCodigoError
    try {
      const codeElement = await frame.$('#lblCodigoError');
      if (codeElement) {
        errorCode = (await codeElement.textContent())?.trim() || null;
      }
    } catch { /* ignore */ }

    // Extract server from #server element
    try {
      const serverElement = await frame.$('#server');
      if (serverElement) {
        server = (await serverElement.textContent())?.trim() || null;
      }
    } catch { /* ignore */ }

    // If we found at least a message, this is an error page
    if (message || errorCode) {
      return {
        message: message || 'Unknown Banesco error',
        errorCode,
        server,
        isTransientOutage: isTransientBanescoError(message, errorCode),
      };
    }

    return null;
  } catch (error) {
    log(`Error checking for Banesco error page: ${error}`);
    return null;
  }
}

/**
 * Check if the page shows authenticated chrome (logout link, etc.). Helps detect
 * successful login even if the URL remains on login.aspx.
 */
export async function checkForAuthenticatedUi(
  page: Page,
  log: Logger = noop,
): Promise<boolean> {
  try {
    const pageContent = await page.content();

    // Check for logout link presence (authenticated indicator)
    const hasLogoutLink =
      pageContent.includes('salir.aspx') ||
      pageContent.includes('ctl00_btnSalir_lkButton') ||
      pageContent.includes('icon-salida');

    if (hasLogoutLink) {
      log('Found authenticated chrome (logout link)');
      return true;
    }

    // Also check iframe content for authenticated indicators
    const iframeElement = await page.$(BANESCO_URLS.IFRAME_SELECTOR);
    if (iframeElement) {
      const frame = await iframeElement.contentFrame();
      if (frame) {
        const frameContent = await frame.content();
        if (frameContent.includes('salir.aspx') ||
            frameContent.includes('Cerrar Sesión') ||
            frameContent.includes('Bienvenido')) {
          log('Found authenticated indicators in iframe');
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Verify if login was successful using Banesco-specific indicators. Returns the
 * success flag plus any Banesco error page detected along the way (the caller
 * records it as its `lastBanescoError`).
 */
export async function verifyLoginSuccess(
  page: Page,
  log: Logger = noop,
): Promise<LoginVerification> {
  try {
    log('Verifying login success...');

    // Poll for URL change (up to 15 seconds)
    const MAX_WAIT_MS = 15000;
    const POLL_INTERVAL_MS = 500;
    let elapsed = 0;

    while (elapsed < MAX_WAIT_MS) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      elapsed += POLL_INTERVAL_MS;

      const currentUrl = page.url().toLowerCase();

      // Check if we've navigated away from login page
      if (currentUrl.includes('default.aspx') ||
          currentUrl.includes('principal.aspx') ||
          currentUrl.includes('index.aspx')) {
        log(`Current URL: ${page.url()}`);
        log('Login verification successful by URL pattern');
        return { success: true, error: null };
      }

      // Check for authenticated chrome (logout link) early
      if (await checkForAuthenticatedUi(page, log)) {
        log(`Current URL: ${page.url()}`);
        return { success: true, error: null };
      }

      // Check for Banesco error page in iframe (fail fast on outage)
      const errorDetails = await checkForBanescoErrorPage(page, log);
      if (errorDetails) {
        const errorInfo = errorDetails.errorCode
          ? `${errorDetails.errorCode}${errorDetails.server ? ' / ' + errorDetails.server : ''}`
          : 'unknown';
        log(`Banesco error page detected (${errorInfo}): ${errorDetails.message}`);
        return { success: false, error: errorDetails };
      }
    }

    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    // Final check for Banesco error page before trying navigation
    const errorBeforeNav = await checkForBanescoErrorPage(page, log);
    if (errorBeforeNav) {
      const errorInfo = errorBeforeNav.errorCode
        ? `${errorBeforeNav.errorCode}${errorBeforeNav.server ? ' / ' + errorBeforeNav.server : ''}`
        : 'unknown';
      log(`Banesco error page detected (${errorInfo}): ${errorBeforeNav.message}`);
      return { success: false, error: errorBeforeNav };
    }

    // Still on login page - try to navigate to dashboard explicitly
    const urlLower = currentUrl.toLowerCase();
    if (urlLower.includes('login.aspx')) {
      log('Still on login page, trying explicit navigation to dashboard...');

      try {
        await page.goto(BANESCO_URLS.DASHBOARD, {
          waitUntil: 'domcontentloaded',
          timeout: 10000
        });
        await page.waitForTimeout(2000);

        const newUrl = page.url().toLowerCase();
        if (newUrl.includes('default.aspx') && !newUrl.includes('login')) {
          log('Login verified - navigated to dashboard successfully');
          return { success: true, error: null };
        }

        // If we got redirected back to login, check for error page again
        if (newUrl.includes('login.aspx')) {
          const errorAfterNav = await checkForBanescoErrorPage(page, log);
          if (errorAfterNav) {
            const errorInfo = errorAfterNav.errorCode
              ? `${errorAfterNav.errorCode}${errorAfterNav.server ? ' / ' + errorAfterNav.server : ''}`
              : 'unknown';
            log(`Banesco unavailable (${errorInfo}): ${errorAfterNav.message}`);
            return { success: false, error: errorAfterNav };
          }
          log('Login failed - redirected back to login page');
          return { success: false, error: null };
        }
      } catch (navError) {
        log(`Navigation error: ${navError}`);
      }
    }

    // Check page content for authenticated indicators
    try {
      const pageContent = await page.content();
      const authenticatedIndicators = [
        'Cerrar Sesión',
        'cerrar sesion',
        'Bienvenido',
        'Mi cuenta',
        'Saldo disponible',
        'Consulta de saldos',
        'Cuenta Corriente',
        'Cuenta de Ahorro'
      ];

      for (const indicator of authenticatedIndicators) {
        if (pageContent.toLowerCase().includes(indicator.toLowerCase())) {
          log(`Login verified by content indicator: "${indicator}"`);
          return { success: true, error: null };
        }
      }
    } catch {
      // Continue with other checks
    }

    // Check for system availability iframe (Banesco-specific)
    try {
      const systemIframe = await page.$('#ctl00_cp_frmCAU');
      if (systemIframe) {
        const systemFrame = await systemIframe.contentFrame();
        if (systemFrame) {
          const systemStatus = await systemFrame.$('.StatusSystemOK, .available');
          if (systemStatus) {
            log('Login verified by system status iframe');
            return { success: true, error: null };
          }
        }
      }
    } catch {
      // Continue with other checks
    }

    // Final check - if we're still on login page, authentication failed
    const finalUrl = page.url().toLowerCase();
    if (finalUrl.includes('login.aspx')) {
      // One last check for error page
      const finalError = await checkForBanescoErrorPage(page, log);
      if (finalError) {
        const errorInfo = finalError.errorCode
          ? `${finalError.errorCode}${finalError.server ? ' / ' + finalError.server : ''}`
          : 'unknown';
        log(`Banesco unavailable (${errorInfo}): ${finalError.message}`);
        return { success: false, error: finalError };
      }
      log('Login verification failed - still on login page');
      log(`   URL: ${page.url()}`);
      return { success: false, error: null };
    }

    // We're not on login page, consider it a success
    log('Login appears successful - no longer on login page');
    return { success: true, error: null };

  } catch (error) {
    log(`Error during login verification: ${error}`);
    return { success: false, error: null };
  }
}
