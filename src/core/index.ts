/**
 * Core Module
 *
 * Bank-agnostic domain models and transaction normalization.
 *
 * @example
 * ```typescript
 * import { normalizeTransaction, makeTxnKey, type Transaction } from '@danicanod/banker/core';
 *
 * // Normalize any bank's transaction
 * const normalized = normalizeTransaction('banesco', {
 *   date: '2025-01-15',
 *   amount: 1500.50,
 *   description: 'Transfer received',
 *   type: 'credit',
 *   reference: 'REF123456'
 * });
 *
 * console.log(normalized.txnKey);  // "banesco-a1b2c3d4e5f6g7h8"
 * ```
 */

// Types
export type {
  BankCode,
  TransactionType,
  Transaction,
  TxnKeyInput,
  BankTransactionInput,
  NormalizeOptions,
  Account,
} from './types.js';

// Transaction utilities
export { makeTxnKey, normalizeTransaction, normalizeTransactions } from './transactions.js';
