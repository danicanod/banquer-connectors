/**
 * Transaction Normalization
 *
 * Utilities for normalizing bank transactions into a unified format
 * and generating deterministic transaction keys for idempotent storage.
 */

import { createHash } from 'crypto';
import type {
  BankCode,
  Transaction,
  TxnKeyInput,
  BankTransactionInput,
  NormalizeOptions,
} from './types.js';

/**
 * Generate a deterministic transaction key (hash) for idempotent ingestion.
 *
 * ## Key Contract
 *
 * The key is a SHA-256 hash of: `bank|date|amount|type|reference_or_description`
 *
 * - When `reference` is present and non-empty, it's used as the unique identifier
 * - When `reference` is absent, `description` is used as fallback
 * - Amount is always absolute value (positive)
 *
 * This contract ensures consistency across:
 * - Local sync scripts
 * - Convex Browserbase sync
 * - Any other ingestion method
 *
 * @param bank - Bank code (e.g., "banesco", "bnc")
 * @param tx - Transaction data with at least date, amount, description, and type
 * @returns Deterministic key in format `{bank}-{16_char_hash}`
 *
 * @example
 * ```typescript
 * const key = makeTxnKey('banesco', {
 *   date: '2025-01-15',
 *   amount: -1500.50,
 *   description: 'ATM Withdrawal',
 *   type: 'debit'
 * });
 * // Returns: "banesco-a1b2c3d4e5f6g7h8"
 * ```
 */
export function makeTxnKey(bank: string, tx: TxnKeyInput): string {
  // Prefer reference when available (more stable identifier)
  const identifier = tx.reference?.trim() || tx.description.trim();
  const key = [
    bank,
    tx.date,
    String(Math.abs(tx.amount)),
    tx.type,
    identifier,
  ].join('|');
  return `${bank}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * Normalize a bank-specific transaction into the unified Transaction format.
 *
 * This function:
 * 1. Extracts standard fields from bank-specific formats
 * 2. Generates a deterministic `txnKey` using the key contract
 * 3. Ensures consistent field naming and types
 *
 * @param bank - Bank code (e.g., "banesco", "bnc")
 * @param tx - Bank-specific transaction object
 * @param options - Normalization options
 * @returns Normalized Transaction object
 *
 * @example
 * ```typescript
 * // Normalize a transaction
 * const normalized = normalizeTransaction('banesco', banescoTx);
 *
 * // Normalize with account override
 * const normalized = normalizeTransaction('bnc', bncTx, {
 *   accountId: 'USD-0816'
 * });
 *
 * // Normalize without raw data (smaller payload)
 * const normalized = normalizeTransaction('banesco', tx, {
 *   includeRaw: false
 * });
 * ```
 */
export function normalizeTransaction(
  bank: BankCode,
  tx: BankTransactionInput,
  options: NormalizeOptions = {}
): Transaction {
  const { accountId: overrideAccountId, includeRaw = true } = options;

  // Extract reference (some banks use referenceNumber, others use reference)
  const reference =
    (tx.referenceNumber && typeof tx.referenceNumber === 'string' ? tx.referenceNumber : undefined) ||
    (tx.reference && typeof tx.reference === 'string' ? tx.reference : undefined) ||
    undefined;

  // Extract account ID (multiple possible field names)
  const accountId =
    overrideAccountId ||
    (tx.accountId && typeof tx.accountId === 'string' ? tx.accountId : undefined) ||
    (tx.accountName && typeof tx.accountName === 'string' ? tx.accountName : undefined) ||
    undefined;

  // Use existing id if present (some clients already compute ids), else generate
  const existingId = tx.id && typeof tx.id === 'string' && tx.id.length > 0 ? tx.id : null;

  const txnKey =
    existingId ||
    makeTxnKey(bank, {
      date: tx.date,
      amount: tx.amount,
      description: tx.description,
      type: tx.type,
      reference,
    });

  const normalized: Transaction = {
    bank,
    txnKey,
    date: tx.date,
    amount: Math.abs(tx.amount),
    description: tx.description,
    type: tx.type,
  };

  // Add optional fields
  if (reference) {
    normalized.reference = reference;
  }

  if (accountId) {
    normalized.accountId = accountId;
  }

  if (includeRaw) {
    normalized.raw = tx;
  }

  return normalized;
}

/**
 * Normalize multiple transactions at once.
 *
 * @param bank - Bank code
 * @param transactions - Array of bank-specific transactions
 * @param options - Normalization options (applied to all)
 * @returns Array of normalized Transaction objects
 *
 * @example
 * ```typescript
 * const normalized = normalizeTransactions('bnc', bncTransactions);
 * ```
 */
export function normalizeTransactions(
  bank: BankCode,
  transactions: BankTransactionInput[],
  options: NormalizeOptions = {}
): Transaction[] {
  return transactions.map((tx) => normalizeTransaction(bank, tx, options));
}
