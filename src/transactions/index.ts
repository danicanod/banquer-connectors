/**
 * Unified Transaction Model and Normalization Utilities
 *
 * @deprecated Import from '@danicanod/banquer-connectors/core' instead.
 * This module re-exports from core for backward compatibility.
 *
 * @example
 * ```typescript
 * // New way (preferred):
 * import { normalizeTransaction, makeTxnKey, type Transaction } from '@danicanod/banquer-connectors/core';
 *
 * // Old way (still works):
 * import { normalizeTransaction, makeTxnKey, type Transaction } from '@danicanod/banquer-connectors';
 * ```
 */

// Re-export everything from core for backward compatibility
export type {
  BankCode,
  TransactionType,
  Transaction,
  TxnKeyInput,
  BankTransactionInput,
  NormalizeOptions,
} from '../core/index.js';

export { makeTxnKey, normalizeTransaction, normalizeTransactions } from '../core/index.js';
