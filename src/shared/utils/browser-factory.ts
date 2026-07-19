/**
 * Browser stealth helpers extracted from BaseBankAuth.
 *
 * `applyStealthMeasures` registers an init script on the context (so it applies
 * to all pages and iframes, on the next navigation) that overrides the browser
 * properties bot-detection commonly checks — navigator.webdriver, plugins,
 * languages, platform, the chrome runtime shim, permissions, and native
 * function toString(). Registered via addInitScript so it also covers reused
 * (remote/CDP) contexts.
 */

import type { BrowserContext } from 'playwright';

export async function applyStealthMeasures(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Override navigator.webdriver - most common bot detection
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // Override navigator.plugins to look like a real browser
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        // Make it array-like with length
        const pluginArray = Object.create(PluginArray.prototype);
        plugins.forEach((p, i) => {
          pluginArray[i] = p;
        });
        Object.defineProperty(pluginArray, 'length', { value: plugins.length });
        return pluginArray;
      },
      configurable: true,
    });

    // Override navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['es-VE', 'es-419', 'es', 'en'],
      configurable: true,
    });

    // Override navigator.platform to match Windows user agent
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
      configurable: true,
    });

    // Override navigator.hardwareConcurrency (realistic value)
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });

    // Override navigator.deviceMemory (realistic value)
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
      configurable: true,
    });

    // Override chrome runtime to look like real Chrome
    // Use unknown cast to safely assign to window.chrome (browser-specific global)
    const chromeShim = {
      runtime: {
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {} },
      },
      loadTimes: () => ({}),
      csi: () => ({}),
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
    Function.prototype.toString = function () {
      if (this === Function.prototype.toString) {
        return 'function toString() { [native code] }';
      }
      return originalFunction.call(this);
    };
  });
}
