/**
 * BNC transaction parser.
 *
 * Stateless HTML transaction parsing for BNC's `#Tbl_Transactions` grid,
 * extracted from BncHttpClient so it can be unit-tested in isolation. Produces a
 * deterministic `bnc-<hash>` id per row for idempotent ingestion.
 */

import { createHash } from 'crypto';
import * as cheerio from 'cheerio';
import type { BncTransaction } from '../types/index.js';
import { parseVesAmount, toMessage } from '../../../shared/utils/text.js';

export class BncTransactionParser {
  constructor(private readonly log: (message: string) => void = () => {}) {}

  /** Parse the BNC transactions table into normalized rows. */
  parse(html: string, accountName = ''): BncTransaction[] {
    const $ = cheerio.load(html);
    const transactions: BncTransaction[] = [];

    const table = $('#Tbl_Transactions');
    if (table.length === 0) {
      this.log('    No transaction table found');
      return [];
    }

    table.find('tbody tr.cursor-pointer').each((_, row) => {
      try {
        const cells = $(row).find('td');
        if (cells.length < 4) return;

        const dateStr = $(cells[0]).text().trim();
        const typeStr = $(cells[1]).text().trim();
        const reference = $(cells[2]).text().trim();
        const amountStr = $(cells[3]).text().trim();

        // Description/memo lives in the collapsible detail row that follows.
        const nextRow = $(row).next('tr');
        let description = '';
        if (nextRow.length > 0) {
          description =
            nextRow.find('.font-size-custom').first().text().trim() ||
            nextRow.find('.collapse').text().trim() ||
            nextRow.find('div').first().text().trim() ||
            nextRow.find('td').text().trim();
        }

        const date = this.parseDate(dateStr);
        const amount = parseVesAmount(amountStr);
        const transactionType = this.determineTransactionType(amountStr, typeStr);

        transactions.push({
          id: this.makeId(date, amount, reference, description || typeStr, transactionType, accountName),
          date,
          description: description || typeStr,
          amount: Math.abs(amount),
          type: transactionType,
          reference,
          bankName: 'BNC',
          transactionType: typeStr,
          referenceNumber: reference,
          accountName,
        });
      } catch (err) {
        this.log(`    Skipped malformed transaction row: ${toMessage(err)}`);
      }
    });

    return transactions;
  }

  /**
   * Deterministic id from stable fields, so re-fetching the same movement
   * yields the same id (idempotent ingestion even when references repeat).
   */
  private makeId(
    date: string,
    amount: number,
    reference: string,
    description: string,
    type: 'debit' | 'credit',
    accountName: string
  ): string {
    const stableKey = [date, String(Math.abs(amount)), reference, description, type, accountName].join('|');
    return `bnc-${createHash('sha256').update(stableKey).digest('hex').slice(0, 16)}`;
  }

  /** "DD/MM/YYYY" or "DD-MM-YYYY" -> "YYYY-MM-DD"; returns input unchanged if unrecognized. */
  private parseDate(dateString: string): string {
    const m = dateString.trim().match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (!m) return dateString;
    const [, day, month, year] = m;
    const fullYear = year.length === 2 ? `20${year}` : year;
    return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  private determineTransactionType(amountString: string, typeString: string): 'debit' | 'credit' {
    if (amountString.includes('-')) return 'debit';

    const lowerType = typeString.toLowerCase();
    const debitPatterns = ['débito', 'debito', 'cargo', 'retiro', 'pago', 'transferencia enviada'];
    const creditPatterns = ['crédito', 'credito', 'abono', 'depósito', 'deposito', 'transferencia recibida'];

    if (debitPatterns.some((p) => lowerType.includes(p))) return 'debit';
    if (creditPatterns.some((p) => lowerType.includes(p))) return 'credit';
    return 'credit'; // default: positive amounts are credits
  }
}
