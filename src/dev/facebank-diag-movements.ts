/**
 * Dev-only diagnostic: after logging in, click "Consulta de Movimientos" exactly
 * like the connector does, then dump the post-click state of EVERY frame (URL,
 * treegrid presence + row count, buttons, selects) plus HTML + a screenshot, so
 * we can see why the movements grid isn't found.
 *
 * Run in your terminal (enter the emailed OTP at the prompt):
 *   npx tsx src/dev/facebank-diag-movements.ts
 * Results are written to the scratchpad (I read them): diag-summary.txt, diag-frame*.html, diag-movements.png
 */

import 'dotenv/config';
import { writeFileSync, appendFileSync } from 'fs';
import { FacebankAuth } from '../banks/facebank/auth/facebank-auth.js';

const OUT =
  '/private/tmp/claude-501/-Users-Daniel-Documents-Projects-misc-banquer-connectors/9ba5a9dd-e58b-4cd5-a8dc-7d6b7025517f/scratchpad';
const SUMMARY = `${OUT}/diag-summary.txt`;

function out(line: string): void {
  console.log(line);
  try {
    appendFileSync(SUMMARY, line + '\n');
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  writeFileSync(SUMMARY, `Facebank movements diagnostic\n`);
  const username = process.env.FACEBANK_USERNAME;
  const password = process.env.FACEBANK_PASSWORD;
  if (!username || !password) {
    out('Missing FACEBANK_USERNAME/FACEBANK_PASSWORD in .env');
    process.exit(1);
  }

  const auth = new FacebankAuth({ username, password }, { headless: false, debug: false });
  const login = await auth.login(); // stdin OTP prompt
  out(`login: ${JSON.stringify(login)}`);
  if (!login.success) {
    await auth.close();
    return;
  }
  const page = auth.getPage();
  if (!page) {
    out('no page');
    await auth.close();
    return;
  }

  // Click the movements link exactly like the scraper.
  const link = page.locator('a[title="Consulta de Movimientos"]').first();
  out(`movements link visible: ${await link.isVisible().catch(() => false)}`);
  await link.click().catch((e) => out(`click error: ${e}`));
  out('clicked "Consulta de Movimientos"; waiting 12s for the composite view to load...');
  await page.waitForTimeout(12000);

  const frames = page.frames();
  out(`\nFRAME COUNT: ${frames.length}`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let hasGrid = false;
    let gridVisible = false;
    let rows = 0;
    const buttons: string[] = [];
    const selects: string[][] = [];
    try {
      const t = await f.$('table[role="treegrid"]');
      hasGrid = !!t;
      if (t) {
        gridVisible = await t.isVisible().catch(() => false);
        rows = (await t.$$('tbody tr')).length;
      }
    } catch {
      /* ignore */
    }
    try {
      for (const b of await f.$$('button, input[type=button], input[type=submit], a.k-button')) {
        const tx = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (tx) buttons.push(tx.slice(0, 30));
      }
    } catch {
      /* ignore */
    }
    try {
      for (const s of await f.$$('select')) {
        const opts: string[] = [];
        for (const o of await s.$$('option')) {
          opts.push(((await o.textContent()) || '').replace(/\s+/g, ' ').trim());
        }
        selects.push(opts.slice(0, 6));
      }
    } catch {
      /* ignore */
    }
    out(`\nFRAME[${i}] name=${JSON.stringify(f.name())}`);
    out(`  url=${f.url()}`);
    out(`  treegrid: present=${hasGrid} visible=${gridVisible} tbodyRows=${rows}`);
    out(`  buttons=${JSON.stringify(buttons.slice(0, 14))}`);
    out(`  selects=${JSON.stringify(selects)}`);
    if (hasGrid || /IBKUX|MOVEMENT|CNSLD|container/i.test(f.url() + f.name())) {
      try {
        writeFileSync(`${OUT}/diag-frame${i}.html`, await f.content());
        out(`  -> dumped diag-frame${i}.html`);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await page.screenshot({ path: `${OUT}/diag-movements.png`, fullPage: true });
    out('\nscreenshot: diag-movements.png');
  } catch {
    /* ignore */
  }

  // If a "Buscar" (search) button exists, click it and see whether the grid
  // then populates — this tells us if a search must be triggered after nav.
  for (const f of page.frames()) {
    const btn = f.locator('button:has-text("Buscar"), input[value="Buscar"], a:has-text("Buscar")').first();
    if (await btn.isVisible().catch(() => false)) {
      out(`\nFound "Buscar" in frame ${f.url()} — clicking it...`);
      await btn.click().catch((e) => out(`buscar click error: ${e}`));
      await page.waitForTimeout(9000);
      let rows = 0;
      let present = false;
      try {
        const t = await f.$('table[role="treegrid"]');
        present = !!t;
        if (t) rows = (await t.$$('tbody tr')).length;
      } catch {
        /* ignore */
      }
      out(`  after Buscar: treegrid present=${present} tbodyRows=${rows}`);
      try {
        writeFileSync(`${OUT}/diag-after-buscar.html`, await f.content());
        out('  -> dumped diag-after-buscar.html');
      } catch {
        /* ignore */
      }
      try {
        await page.screenshot({ path: `${OUT}/diag-after-buscar.png`, fullPage: true });
      } catch {
        /* ignore */
      }
      break;
    }
  }

  out('DONE');
  await page.waitForTimeout(2000);
  await auth.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
