/**
 * Dev-only diagnostic: verify the Facebank login page renders through the REAL
 * connector browser path (BaseBankAuth launch args + stealth + request
 * interception), WITHOUT entering credentials or logging in. Loads only the
 * public login page and checks that the Angular form renders (#username).
 *
 * Run: npx tsx src/dev/facebank-render-check.ts
 */

import 'dotenv/config';
import { FacebankAuth } from '../banks/facebank/auth/facebank-auth.js';

const OUT =
  '/private/tmp/claude-501/-Users-Daniel-Documents-Projects-misc-banquer-connectors/9ba5a9dd-e58b-4cd5-a8dc-7d6b7025517f/scratchpad/facebank-render-check.png';

// Expose the protected init/navigate steps for an isolated render check.
class RenderCheck extends FacebankAuth {
  async run(): Promise<void> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const self = this as any;
    await self.initializeBrowser();
    const page = self.page;
    console.log('[check] navigating to', self.getLoginUrl());
    await page.goto(self.getLoginUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ready = await self.waitForElementReady('#username', 20000);
    console.log('[check] url        :', page.url());
    console.log('[check] title      :', await page.title());
    console.log('[check] #username  :', ready ? 'RENDERED ✅' : 'NOT FOUND ❌');
    const btn = await page.$('#btnLogin');
    console.log('[check] #btnLogin  :', btn ? 'present' : 'missing');
    await page.screenshot({ path: OUT, fullPage: true }).catch(() => {});
    console.log('[check] screenshot :', OUT);
    await this.close();
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}

const headless = process.env.RENDER_HEADLESS !== 'false';
const rc = new RenderCheck({ username: 'x', password: 'y' }, { headless, timeout: 45000, debug: true });
rc.run().catch((e) => {
  console.error('[check] RENDER CHECK ERROR:', e);
  process.exit(1);
});
