/**
 * Facebank Login/Data Recon Script (dev-only, excluded from build/lint)
 *
 * Opens Facebank in a HEADED browser and pauses between screens so a human can
 * drive every sensitive step (username/password, image+secret, OTP). On each
 * Enter it captures the current page + every frame:
 *   - full HTML                -> <OUT>/<label>-frameN.html
 *   - a structured element map -> <OUT>/<label>-elements.json
 * It also records every COBIS API call (redacted request bodies + JSON response
 * bodies for data endpoints) to <OUT>/api-log.json so we can design the data
 * layer without reverse-engineering minified JS.
 *
 * The script never types your credentials — YOU interact with the browser
 * window; it only observes and dumps the DOM/API traffic.
 *
 * Usage (run in your OWN terminal so the interactive prompts work):
 *   npx tsx src/dev/recon-facebank.ts 'https://secureib.facebank.pr/personas/banca-virtual#!/login'
 *   # (single-quote the URL — the #! trips zsh history expansion)
 *   # or set FACEBANK_LOGIN_URL in the environment / .env
 *
 * Suggested flow — press Enter to capture at EACH of these screens:
 *   1. login  2. image+secret (if shown)  3. OTP  4. home
 *   5. Consulta de Movimientos (pick an account)  6. Posición Consolidada > Saldos
 *   then type "done".
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { promptForInput } from '../shared/utils/interactive.js';

const OUT_DIR =
  process.env.RECON_OUT ||
  '/private/tmp/claude-501/-Users-Daniel-Documents-Projects-misc-banquer-connectors/9ba5a9dd-e58b-4cd5-a8dc-7d6b7025517f/scratchpad/facebank-recon2';

// Endpoints whose request bodies carry secrets (never persist their payloads).
const SENSITIVE_REQ = /encrypt|authentication\/public\/login|validImagen|getImagen|validUser|security\/public/i;
// Endpoints whose responses carry crypto/JWT material (skip response bodies).
const SKIP_RESP_BODY = /encrypt|authentication\/public\/login/i;

/**
 * Element-extraction source, passed to frame.evaluate() as a STRING (not a
 * function) on purpose: tsx/esbuild's keepNames wraps named functions with a
 * __name() helper that is undefined in the page context, which breaks
 * evaluate(fn). A string expression sidesteps that entirely.
 */
const EXTRACT_SRC = String.raw`(() => {
  const isVisible = (el) => {
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    } catch (e) { return false; }
  };
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    let s = el.tagName.toLowerCase();
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) s += '[name="' + nm + '"]';
    if (typeof el.className === 'string' && el.className.trim()) {
      const c = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (c) s += '.' + c;
    }
    return s;
  };
  const txt = (el) => ((el.innerText || el.value || '') + '').trim().slice(0, 60);
  const arr = (q) => Array.prototype.slice.call(document.querySelectorAll(q));
  const inputs = arr('input, textarea, select').map((el) => ({
    selector: sel(el), tag: el.tagName.toLowerCase(), id: el.id || null,
    name: el.getAttribute('name') || null, type: el.getAttribute('type') || null,
    ngModel: el.getAttribute('ng-model') || null, placeholder: el.getAttribute('placeholder') || null,
    ariaLabel: el.getAttribute('aria-label') || null, maxLength: el.getAttribute('maxlength') || null,
    visible: isVisible(el)
  }));
  const buttons = arr('button, input[type=submit], input[type=button], a[ng-click], [ng-click], [onclick]').map((el) => ({
    selector: sel(el), tag: el.tagName.toLowerCase(), id: el.id || null,
    ngClick: el.getAttribute('ng-click') || null, text: txt(el),
    title: el.getAttribute('title') || null, href: el.getAttribute('href') || null, visible: isVisible(el)
  }));
  const images = arr('img').map((el) => ({
    selector: sel(el), id: el.id || null, alt: el.getAttribute('alt'), title: el.getAttribute('title'),
    src: (el.getAttribute('src') || '').slice(0, 160), ngClick: el.getAttribute('ng-click') || null,
    className: (typeof el.className === 'string' && el.className) || null,
    naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, visible: isVisible(el)
  }));
  const tables = arr('table').map((el) => ({
    selector: sel(el), id: el.id || null, className: (typeof el.className === 'string' && el.className) || null,
    rows: el.querySelectorAll('tr').length,
    headers: arr.call(null, 'th').filter((th) => el.contains(th)).map((th) => th.innerText.trim()).slice(0, 12)
  }));
  const bodyText = (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { title: document.title, url: location.href, inputs, buttons, images, tables, bodyText };
})()`;

async function capture(page: import('playwright').Page, label: string): Promise<void> {
  const frames = page.frames();
  const perFrame: unknown[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let html = '';
    let map: unknown = null;
    try {
      html = await f.content();
    } catch (e) {
      html = `<!-- could not read frame content: ${e} -->`;
    }
    try {
      map = await f.evaluate(EXTRACT_SRC);
    } catch (e) {
      map = { error: String(e) };
    }
    writeFileSync(join(OUT_DIR, `${label}-frame${i}.html`), html);
    perFrame.push({ index: i, url: f.url(), name: f.name(), map });
  }
  writeFileSync(
    join(OUT_DIR, `${label}-elements.json`),
    JSON.stringify({ label, pageUrl: page.url(), frameCount: frames.length, frames: perFrame }, null, 2)
  );
  console.log(`\n===== CAPTURE: ${label} =====  URL: ${page.url()}  frames: ${frames.length}`);
  for (const fr of perFrame as any[]) {
    const m = fr.map || {};
    if (m.error) {
      console.log(`  frame[${fr.index}] ${fr.url || '(main)'} | extract error: ${m.error}`);
      continue;
    }
    const vin = (m.inputs || []).filter((x: any) => x.visible);
    const vbtn = (m.buttons || []).filter((x: any) => x.visible);
    console.log(
      `  frame[${fr.index}] ${fr.url || '(main)'} | inputs:${vin.length} buttons:${vbtn.length}` +
        ` imgs:${(m.images || []).length} tables:${(m.tables || []).length}`
    );
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const url =
    process.env.FACEBANK_LOGIN_URL ||
    process.argv[2] ||
    (await promptForInput('Paste the exact Facebank online-banking login URL: '));

  console.log('='.repeat(70));
  console.log('FACEBANK RECON v2 (captures API response bodies)');
  console.log(`URL    : ${url}`);
  console.log(`Output : ${OUT_DIR}`);
  console.log('='.repeat(70));

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'es-VE',
    timezoneId: 'America/Caracas',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Custom API capture: redacted request bodies + JSON response bodies for
  // COBIS data endpoints. (We roll our own instead of NetworkLogger because the
  // latter doesn't record response bodies and mishandles JSON request bodies.)
  const apiCalls: unknown[] = [];
  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch' && req.method() !== 'POST') return;
      const u = new URL(resp.url());
      if (!u.pathname.includes('/services/resources/cobis/') && !/login|otp|auth|imagen|movim|account|saldo|balance|transaction/i.test(u.pathname)) {
        return;
      }
      const ct = resp.headers()['content-type'] || '';
      let reqBody: string | undefined = req.postData() || undefined;
      if (reqBody && SENSITIVE_REQ.test(u.pathname)) reqBody = '[REDACTED]';
      let respBody: string | undefined;
      if (ct.includes('json') && !SKIP_RESP_BODY.test(u.pathname)) {
        try {
          respBody = await resp.text();
        } catch {
          /* body unavailable */
        }
        if (respBody && respBody.length > 40000) respBody = respBody.slice(0, 40000) + '...[truncated]';
      }
      apiCalls.push({
        method: req.method(),
        path: u.pathname,
        query: u.search.slice(0, 200) || undefined,
        status: resp.status(),
        contentType: ct,
        reqBody,
        respBody,
      });
    } catch {
      /* ignore capture errors */
    }
  });

  try {
    console.log(`\nNavigating to ${url} ...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    let step = 1;
    await capture(page, `step${String(step).padStart(2, '0')}-initial`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ans = await promptForInput(
        `\nAdvance to the NEXT screen in the browser, then press Enter to capture it — or type "done": `
      );
      if (['done', 'q', 'quit', 'exit'].includes(ans.toLowerCase())) break;
      step++;
      await page.waitForTimeout(500);
      await capture(page, `step${String(step).padStart(2, '0')}`);
      // Flush API log after each step so nothing is lost if the run is interrupted.
      writeFileSync(join(OUT_DIR, 'api-log.json'), JSON.stringify(apiCalls, null, 2));
    }
  } catch (error) {
    console.error('\nRecon error:', error);
  } finally {
    writeFileSync(join(OUT_DIR, 'api-log.json'), JSON.stringify(apiCalls, null, 2));
    console.log('\n' + '='.repeat(70));
    console.log(`API log  : ${join(OUT_DIR, 'api-log.json')} (${apiCalls.length} calls)`);
    console.log(`Captures : ${OUT_DIR}`);
    console.log('='.repeat(70));
    await browser.close();
    console.log('Browser closed.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
