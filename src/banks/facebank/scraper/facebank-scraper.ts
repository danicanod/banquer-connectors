/**
 * Facebank in-browser data scraper.
 *
 * Facebank (COBIS CWC) renders account data as Kendo grids inside nested view
 * iframes of the SPA shell; there is no clean standalone data API, so we read
 * the rendered tables from the live, authenticated Playwright page.
 *
 * Navigation model (from recon): on #!/home a menu/favorite link
 * "Consulta de Movimientos" loads the movements view into a nested
 * `container-view` iframe. That view holds an account selector (a Kendo dropdown
 * whose options read "<account> - <CUR> <balance>") and a Kendo treegrid of
 * movements (columns Fecha/REF/Descripción/Monto/Saldo; negative Monto = debit)
 * whose rows populate asynchronously after the grid element appears.
 *
 * All DOM reads use Playwright element handles (never in-page `evaluate(fn)`) so
 * the code behaves identically under `tsx` and after a `tsc` build. Options are
 * read via `textContent` because Kendo hides the underlying <select>.
 */

import { Frame, Page } from 'playwright';
import {
  FacebankAccount,
  FacebankTransaction,
  FacebankAccountsResult,
  FacebankMovementsResult,
} from '../types/index.js';

/** Menu link titles that open the movements view, in order of preference. */
const MOVEMENTS_LINK_TITLES = ['Consulta de Movimientos', 'Últimos Movimientos', 'Movimientos'];

/** The movements/statement data grid (confirmed via recon). */
const TREEGRID_SELECTOR = 'table[role="treegrid"]';

/** dd/MM/yyyy — used to recognise real data rows. */
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Account option text: "<account> - <CUR> <balance>", e.g. "X-XXX-XXX581-2 - USD 151.48". */
const ACCOUNT_OPTION_RE = /^(.+?)\s*-\s*([A-Z]{3})\s+(-?[\d.,]+)$/;

export class FacebankScraper {
  constructor(
    private readonly page: Page,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /**
   * Read movements for the account currently shown in the movements view.
   * (Account/date filtering is a future enhancement; for a single-account login
   * the view auto-loads recent movements.)
   */
  async getAccountMovements(): Promise<FacebankMovementsResult> {
    try {
      const frame = await this.openMovementsView();
      if (!frame) {
        return {
          success: false,
          message: 'Could not open the movements view',
          transactions: [],
          error: 'movements_view_not_found',
        };
      }

      await this.waitForRows(frame, 15000); // Kendo populates rows async
      const accountNumber = await this.readSelectedAccountNumber(frame);
      const transactions = await this.readTreegrid(frame, accountNumber);

      return {
        success: true,
        message: `Read ${transactions.length} movement(s)`,
        accountNumber,
        transactions,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message, transactions: [], error: message };
    }
  }

  /**
   * List accounts from the account selector in the movements view (each option
   * carries currency + balance), enriched with the selected account's full
   * number/product from the detail panel.
   */
  async getAccounts(): Promise<FacebankAccountsResult> {
    try {
      const frame = await this.openMovementsView();
      if (!frame) {
        return {
          success: false,
          message: 'Could not open the movements view',
          accounts: [],
          error: 'movements_view_not_found',
        };
      }

      const accounts = await this.readAccountOptions(frame);
      await this.enrichSelectedAccount(frame, accounts);

      return {
        success: accounts.length > 0,
        message: accounts.length > 0 ? `Found ${accounts.length} account(s)` : 'No accounts found',
        accounts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message, accounts: [], error: message };
    }
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  /** Navigate to the movements view and return the frame that holds its grid. */
  private async openMovementsView(): Promise<Frame | null> {
    await this.waitForHomeReady();

    // Always navigate explicitly — the home dashboard may itself contain an
    // (unrelated) treegrid, so we don't trust a pre-existing one.
    const clicked = await this.clickMovementsMenu();
    if (!clicked) {
      this.log('Movements menu link not found on the home screen.');
      return null;
    }

    const frame = await this.findFrameWith(TREEGRID_SELECTOR, 25000);
    if (!frame) {
      this.log('Movements grid did not appear after navigation.');
      return null;
    }
    this.log('Movements view loaded.');
    return frame;
  }

  /** Wait until the home shell has rendered its menu/favorites. */
  private async waitForHomeReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      for (const title of MOVEMENTS_LINK_TITLES) {
        if ((await this.page.locator(`a[title="${title}"]`).count().catch(() => 0)) > 0) return;
        if ((await this.page.getByText(title, { exact: true }).count().catch(() => 0)) > 0) return;
      }
      if ((await this.page.locator('button:has-text("Menú Principal")').count().catch(() => 0)) > 0) {
        return;
      }
      await this.page.waitForTimeout(500);
    }
    this.log('Home menu did not appear within 20s; attempting navigation anyway.');
  }

  /** Click a visible "movements" menu/favorite link. Opens the main menu if needed. */
  private async clickMovementsMenu(): Promise<boolean> {
    // 1) Visible favorite/menu link by title attribute.
    if (await this.clickFirstVisible(MOVEMENTS_LINK_TITLES.map((t) => `a[title="${t}"]`))) return true;

    // 2) Open the main menu, then match by visible text.
    const menuBtn = this.page.locator('button:has-text("Menú Principal"), button:has-text("Menu")').first();
    if (await menuBtn.isVisible().catch(() => false)) {
      this.log('Opening main menu...');
      await menuBtn.click().catch(() => {});
      await this.page.waitForTimeout(1000);
    }
    for (const title of MOVEMENTS_LINK_TITLES) {
      const byText = this.page.getByText(title, { exact: true });
      const n = await byText.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = byText.nth(i);
        if (await el.isVisible().catch(() => false)) {
          this.log(`Clicking movements link (text="${title}").`);
          await el.click().catch(() => {});
          await this.page.waitForTimeout(1500);
          return true;
        }
      }
    }
    return false;
  }

  /** Click the first visible element among the given selectors. */
  private async clickFirstVisible(selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const loc = this.page.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          this.log(`Clicking movements link (${selector}).`);
          await el.click().catch(() => {});
          await this.page.waitForTimeout(1500);
          return true;
        }
      }
    }
    return false;
  }

  /** Poll every frame until one contains a visible `selector` (or timeout). */
  private async findFrameWith(selector: string, timeoutMs: number): Promise<Frame | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const frame of this.page.frames()) {
        try {
          const el = await frame.$(selector);
          if (el && (await el.isVisible())) return frame;
        } catch {
          /* frame detached mid-check; ignore */
        }
      }
      await this.page.waitForTimeout(500);
    }
    return null;
  }

  /** Wait until the treegrid in `frame` has at least one real (dated) data row. */
  private async waitForRows(frame: Frame, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const rows = await frame.$$(`${TREEGRID_SELECTOR} tbody tr`);
        for (const row of rows) {
          const td = await row.$('td');
          if (td) {
            const t = ((await td.innerText()) || '').trim();
            if (DATE_RE.test(t)) return;
          }
        }
      } catch {
        /* frame busy; retry */
      }
      await this.page.waitForTimeout(500);
    }
    this.log('No dated rows appeared in the movements grid (account may have no movements).');
  }

  // --------------------------------------------------------------------------
  // Movements grid
  // --------------------------------------------------------------------------

  private async readTreegrid(frame: Frame, accountName?: string): Promise<FacebankTransaction[]> {
    const table = await frame.$(TREEGRID_SELECTOR);
    if (!table) return [];

    // Map columns by header text, falling back to known positions.
    const headerEls = await table.$$('thead th, tr:first-child th');
    const headers: string[] = [];
    for (const th of headerEls) headers.push(((await th.innerText()) || '').trim().toLowerCase());

    const col = (needle: string, fallback: number): number => {
      const idx = headers.findIndex((h) => h.includes(needle));
      return idx >= 0 ? idx : fallback;
    };
    const iDate = col('fecha', 0);
    const iRef = col('ref', 1);
    const iDesc = col('descrip', 2);
    const iAmount = col('monto', 3);

    const rows = await table.$$('tbody tr');
    const transactions: FacebankTransaction[] = [];

    for (const row of rows) {
      const cells = await row.$$('td');
      if (cells.length < 4) continue; // skip detail/spacer rows

      const texts: string[] = [];
      for (const cell of cells) texts.push(((await cell.innerText()) || '').replace(/\s+/g, ' ').trim());

      const date = this.parseDate(texts[iDate]);
      const amount = this.parseAmount(texts[iAmount] ?? '');
      if (!date || amount === null) continue; // not a data row

      transactions.push({
        bankName: 'Facebank',
        accountName,
        date,
        description: texts[iDesc] ?? '',
        reference: texts[iRef] ?? undefined,
        amount: Math.abs(amount),
        type: amount < 0 ? 'debit' : 'credit',
      });
    }

    return transactions;
  }

  // --------------------------------------------------------------------------
  // Accounts
  // --------------------------------------------------------------------------

  private async readAccountOptions(frame: Frame): Promise<FacebankAccount[]> {
    const accounts: FacebankAccount[] = [];
    const seen = new Set<string>();

    const selects = await frame.$$('select');
    for (const select of selects) {
      const options = await select.$$('option');
      for (const option of options) {
        // textContent (not innerText): Kendo hides the underlying <select>.
        const label = ((await option.textContent()) || '').replace(/\s+/g, ' ').trim();
        const m = label.match(ACCOUNT_OPTION_RE);
        if (!m) continue;
        const accountNumber = m[1].trim();
        const currency = m[2];
        const balance = this.parseAmount(m[3]) ?? 0;
        if (seen.has(accountNumber)) continue;
        seen.add(accountNumber);
        accounts.push({
          bankName: 'Facebank',
          accountNumber,
          accountType: '',
          balance,
          availableBalance: balance,
          currency,
          status: 'active',
        });
      }
    }

    return accounts;
  }

  /** Add the selected account's full number/product from the detail panel. */
  private async enrichSelectedAccount(frame: Frame, accounts: FacebankAccount[]): Promise<void> {
    const text = await this.frameText(frame);
    if (!text) return;

    const fullNumber = text.match(/N[uú]mero de Cuenta:\s*(\d[\d-]*\d)/i)?.[1];
    const product = text.match(/Producto:\s*([A-Za-zÁÉÍÓÚÑáéíóúñ ]+?)\s*(?:Fecha|Moneda|Saldo|$)/i)?.[1]?.trim();

    if (!product && !fullNumber) return;

    // With a single account, enrich it directly; otherwise best-effort on the first.
    const acct = accounts[0];
    if (!acct) return;
    if (product) acct.accountType = product;
    // Keep the human-friendly masked number as accountNumber, but record the full
    // one in accountName so downstream callers can key on it if present.
    if (fullNumber) acct.accountName = fullNumber;
  }

  private async readSelectedAccountNumber(frame: Frame): Promise<string | undefined> {
    const text = await this.frameText(frame);
    return text ? text.match(/N[uú]mero de Cuenta:\s*(\d[\d-]*\d)/i)?.[1] : undefined;
  }

  /** Full text of a frame's body (textContent, so hidden nodes are included). */
  private async frameText(frame: Frame): Promise<string | null> {
    const body = await frame.$('body');
    if (!body) return null;
    return ((await body.textContent()) || '').replace(/\s+/g, ' ');
  }

  // --------------------------------------------------------------------------
  // Parsing helpers
  // --------------------------------------------------------------------------

  /** "17/07/2026" (dd/MM/yyyy) -> "2026-07-17"; null if not a date. */
  private parseDate(value?: string): string | null {
    if (!value) return null;
    const m = value.trim().match(DATE_RE);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  /**
   * Parse a COBIS amount ("." decimal, "," thousands): "-1,234.56" -> -1234.56.
   * Returns null when the cell is not a number.
   */
  private parseAmount(value?: string): number | null {
    if (!value) return null;
    const cleaned = value.replace(/,/g, '').replace(/[^0-9.-]/g, '');
    if (!cleaned || !/\d/.test(cleaned)) return null;
    const n = Number.parseFloat(cleaned);
    return Number.isNaN(n) ? null : n;
  }
}
