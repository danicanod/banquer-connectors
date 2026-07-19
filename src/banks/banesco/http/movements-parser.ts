/**
 * Pure Banesco movements/transaction parsers (extracted from BanescoHttpClient).
 *
 * These take raw HTML (or pre-extracted cell rows) and return transactions —
 * no network, no state — so they are unit-testable (see
 * tests/banesco-http-parsers.test.ts).
 *
 * Two parsers are intentionally kept distinct to preserve behavior:
 *   - `parseMovementsFromHtml` / `parseTransactionRowFlexible` — the primary,
 *     position-agnostic parser used for account movements (emits `reference`).
 *   - `parseTransactionRows` (+ its `find*` helpers) — the legacy row parser
 *     still used by the older `getTransactions()` path (no `reference` field).
 */

import * as cheerio from 'cheerio';
import type { BanescoHttpTransaction } from './banesco-http-client.js';

type Logger = (message: string) => void;
const noop: Logger = () => {};

/**
 * Parse movements/transactions from an HTML page. Scans every table, keeps the
 * ones whose header row looks transaction-related, and parses each data row with
 * the flexible parser. Returns [] when the page says there are no movements.
 */
export function parseMovementsFromHtml(
  html: string,
  _accountNumber: string,
  log: Logger = noop,
): BanescoHttpTransaction[] {
  const $ = cheerio.load(html);
  const transactions: BanescoHttpTransaction[] = [];

  // First check for "no movements" messages
  const pageText = $('body').text().toLowerCase();
  const noMovementsPatterns = [
    'no posee movimientos',
    'no hay movimientos',
    'no existen movimientos',
    'sin movimientos',
    'no se encontraron movimientos',
    'no hay registros',
    'sin registros para mostrar'
  ];

  if (noMovementsPatterns.some(pattern => pageText.includes(pattern))) {
    log('   No movements message found on page');
    return [];
  }

  // Look for ALL tables and analyze each one
  $('table').each((_, table) => {
    const $table = $(table);
    const rows = $table.find('tr');

    if (rows.length < 2) return; // Skip tables with only header or no data

    // Check if headers contain transaction-related keywords
    const headerRow = rows.first();
    const headerText = headerRow.text().toLowerCase();
    const containsTransactionHeaders = /fecha|date|monto|amount|descripci[oó]n|description|saldo|balance|d[eé]bito|cr[eé]dito|referencia/i.test(headerText);

    if (!containsTransactionHeaders) return;

    log(`   Found table with transaction headers: ${headerText.substring(0, 50)}...`);

    // Parse data rows (skip header)
    rows.slice(1).each((_, rowEl) => {
      const $row = $(rowEl);
      const cells: string[] = [];

      $row.find('td').each((_, cellEl) => {
        cells.push($(cellEl).text().trim());
      });

      if (cells.length < 3) return;

      // Use flexible parsing (similar to Playwright scraper)
      const tx = parseTransactionRowFlexible(cells);
      if (tx) {
        transactions.push(tx);
      }
    });
  });

  return transactions;
}

/**
 * Flexible row parsing - finds date, amount, description in any cell position.
 */
export function parseTransactionRowFlexible(cells: string[]): BanescoHttpTransaction | null {
  // Find date (DD/MM/YYYY format)
  let date: string | null = null;
  for (const cell of cells) {
    const dateMatch = cell.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (dateMatch) {
      const [, day, month, year] = dateMatch;
      const fullYear = year.length === 2 ? `20${year}` : year;
      date = `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      break;
    }
  }

  // Find amount (number with comma/period)
  let amount = 0;
  let amountCell = '';
  for (const cell of cells) {
    // Look for numeric cells with decimal separators
    const cleanCell = cell.replace(/\s/g, '');
    if (/^[\d.,-]+$/.test(cleanCell) && (cleanCell.includes(',') || cleanCell.includes('.'))) {
      amountCell = cell;
      // Parse Spanish format (1.234,56)
      const normalized = cleanCell.replace(/\./g, '').replace(/,/g, '.');
      amount = Math.abs(parseFloat(normalized)) || 0;
      if (amount > 0) break;
    }
  }

  // Find D/C indicator (D, C, +, or -)
  let transactionType: 'debit' | 'credit' = 'credit';
  for (const cell of cells) {
    const trimmed = cell.trim().toUpperCase();
    if (trimmed === 'D' || trimmed === '-') {
      transactionType = 'debit';
      break;
    } else if (trimmed === 'C' || trimmed === '+') {
      transactionType = 'credit';
      break;
    }
  }

  // Also check if amount was negative
  if (amountCell.includes('-')) {
    transactionType = 'debit';
  }

  // Find reference (numeric string of 6+ digits, not a date or amount)
  let reference: string | undefined = undefined;
  for (const cell of cells) {
    const trimmed = cell.trim().replace(/\s/g, '');
    // Reference is typically a pure numeric string with 6+ digits
    // Skip if it looks like a date (contains / or -)
    if (/[/-]/.test(trimmed)) continue;
    // Skip if it looks like an amount (contains comma or period as decimal)
    if (/[.,]/.test(trimmed)) continue;
    // Skip D/C indicators
    if (/^[DC]$/i.test(trimmed)) continue;
    // Match 6+ digit reference numbers
    if (/^\d{6,}$/.test(trimmed)) {
      reference = trimmed;
      break;
    }
  }

  // Find description (longest text that's not date/amount/reference)
  let description = '';
  for (const cell of cells) {
    const trimmed = cell.trim();
    // Skip if it looks like date, amount, D/C, or reference
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(trimmed)) continue;
    if (/^[\d.,-]+$/.test(trimmed.replace(/\s/g, ''))) continue;
    if (/^[DC]$/i.test(trimmed)) continue;
    if (/^\d{6,}$/.test(trimmed.replace(/\s/g, ''))) continue;

    if (trimmed.length > description.length && trimmed.length > 3) {
      description = trimmed;
    }
  }

  // Require at least date and amount
  if (!date || amount === 0) {
    return null;
  }

  return {
    date,
    description: description || 'Transacción',
    amount,
    type: transactionType,
    reference
  };
}

/**
 * Legacy row parser (still used by the older getTransactions() path). Unlike the
 * flexible parser it does not emit a `reference` field.
 */
export function parseTransactionRows(rows: string[][]): BanescoHttpTransaction[] {
  const transactions: BanescoHttpTransaction[] = [];

  for (const row of rows) {
    if (row.length < 3) continue;

    try {
      const dateStr = findDateInRow(row);
      const amountStr = findAmountInRow(row);
      const description = findDescriptionInRow(row);
      const dcValue = findDCValue(row);

      if (!dateStr || !amountStr) continue;

      const amount = parseAmount(amountStr);
      const type = dcValue === 'D' ? 'debit' : 'credit';

      transactions.push({
        date: parseDate(dateStr),
        description: description || 'Transacción',
        amount: Math.abs(amount),
        type
      });

    } catch {
      continue;
    }
  }

  return transactions;
}

export function findDateInRow(row: string[]): string | null {
  for (const cell of row) {
    if (/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(cell)) {
      return cell;
    }
  }
  return null;
}

export function findAmountInRow(row: string[]): string | null {
  for (const cell of row) {
    if (/[\d.,]+/.test(cell) && (cell.includes(',') || cell.includes('.'))) {
      return cell;
    }
  }
  return null;
}

export function findDescriptionInRow(row: string[]): string | null {
  let longestCell = '';
  for (const cell of row) {
    if (cell.length > longestCell.length &&
        !findDateInRow([cell]) &&
        !findAmountInRow([cell])) {
      longestCell = cell;
    }
  }
  return longestCell || null;
}

export function findDCValue(row: string[]): string {
  for (const cell of row) {
    if (/^[DC]$/i.test(cell.trim())) {
      return cell.trim().toUpperCase();
    }
  }
  return '';
}

export function parseAmount(amountString: string): number {
  const cleanAmount = amountString
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  return parseFloat(cleanAmount) || 0;
}

export function parseDate(dateString: string): string {
  const cleanDate = dateString.replace(/[^\d/-]/g, '');

  if (cleanDate.includes('/')) {
    const parts = cleanDate.split('/');
    if (parts.length === 3) {
      const [day, month, year] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  if (cleanDate.includes('-')) {
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
      const [day, month, year] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  return dateString;
}
