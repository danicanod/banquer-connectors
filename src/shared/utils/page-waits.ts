/**
 * Playwright readiness helpers.
 *
 * Standalone functions (extracted from BaseBankAuth) for waiting on elements
 * and navigation. They take an explicit `page`/`frame` and an optional `log`
 * callback so they carry no class state and are trivially reusable.
 */

import type { Page, Frame } from 'playwright';

type Logger = (message: string) => void;
const noop: Logger = () => {};

/** Wait for an element to exist AND be visible and enabled on a page. */
export async function waitForElementReady(
  page: Page,
  selector: string,
  timeout: number = 10000,
  log: Logger = noop,
): Promise<boolean> {
  try {
    // Wait for element to exist
    await page.waitForSelector(selector, { timeout });

    // Wait for element to be visible and enabled
    await page.waitForFunction(
      (sel) => {
        const element = document.querySelector(sel) as HTMLElement;
        return element &&
               element.offsetParent !== null && // visible
               !element.hasAttribute('disabled'); // enabled
      },
      selector,
      { timeout },
    );

    return true;
  } catch (error) {
    log(` Element not ready: ${selector} - ${error}`);
    return false;
  }
}

/** Wait for an element to exist AND be visible and enabled on a frame. */
export async function waitForElementReadyOnFrame(
  frame: Frame,
  selector: string,
  timeout: number = 10000,
  log: Logger = noop,
): Promise<boolean> {
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
      { timeout },
    );

    return true;
  } catch (error) {
    log(` Element not ready on frame: ${selector} - ${error}`);
    return false;
  }
}

/**
 * Wait for navigation completion by checking for new content. Resolves true if
 * any of `expectedSelectors` appears (checked immediately, then awaited), or on
 * network idle, and optimistically true on timeout (matching prior behavior).
 */
export async function waitForNavigation(
  page: Page,
  expectedSelectors: string[] = [],
  timeout: number = 15000,
  log: Logger = noop,
): Promise<boolean> {
  try {
    log('Waiting for navigation to complete...');

    // First try immediate check - maybe elements are already there
    for (const selector of expectedSelectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          log(`Navigation detected: found ${selector} immediately`);
          return true;
        }
      } catch {
        // Continue checking
      }
    }

    // If not immediate, wait for any of the expected selectors to appear
    if (expectedSelectors.length > 0) {
      log(`Waiting for any of: ${expectedSelectors.join(', ')}`);

      try {
        await Promise.race(
          expectedSelectors.map(selector =>
            page.waitForSelector(selector, { timeout }),
          ),
        );
        log('Navigation detected: new content appeared');
        return true;
      } catch (raceError) {
        log(` None of expected elements appeared: ${raceError}`);
      }
    }

    // Fallback: wait for load state change
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
      log('Navigation completed: network idle');
      return true;
    } catch (loadError) {
      log(` Load state timeout: ${loadError}`);
    }

    log('Navigation assumed successful - continuing');
    return true;

  } catch (error) {
    log(` Navigation timeout: ${error}`);
    return false;
  }
}
