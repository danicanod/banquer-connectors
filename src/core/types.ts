/**
 * Core Types
 *
 * Bank-agnostic domain types for the banquer-connectors library.
 * These types define the canonical formats that all bank implementations should target.
 */

/**
 * Supported bank codes
 */
export type BankCode = 'banesco' | 'bnc' | 'facebank' | string;

/**
 * Transaction type - debit or credit
 */
export type TransactionType = 'debit' | 'credit';

/**
 * Unified normalized transaction model.
 *
 * This is the canonical format for storing transactions across all banks.
 * The `txnKey` provides a deterministic identifier for idempotent ingestion.
 */
export interface Transaction {
  /** Bank code (e.g., "banesco", "bnc") */
  bank: BankCode;

  /** Deterministic unique key for idempotent storage (format: "{bank}-{16_char_hash}") */
  txnKey: string;

  /** Transaction date (ISO format: YYYY-MM-DD) */
  date: string;

  /** Transaction amount (always positive) */
  amount: number;

  /** Transaction description/memo */
  description: string;

  /** Transaction type */
  type: TransactionType;

  /** Bank reference number (when available) */
  reference?: string;

  /** Account identifier (account number or name) */
  accountId?: string;

  /** Original raw transaction data from the bank */
  raw?: unknown;
}

/**
 * Input for transaction key generation.
 *
 * Minimum fields required to generate a deterministic transaction key.
 */
export interface TxnKeyInput {
  /** Transaction date */
  date: string;
  /** Transaction amount */
  amount: number;
  /** Transaction description */
  description: string;
  /** Transaction type ("debit" or "credit") */
  type: string;
  /** Bank reference number (preferred identifier when present) */
  reference?: string;
}

/**
 * Bank-agnostic transaction input for normalization.
 *
 * This interface defines the minimum contract for any bank's transaction data
 * to be normalized. Bank implementations may extend this with additional fields.
 */
export interface BankTransactionInput {
  /** Optional pre-computed ID (if present, used as txnKey) */
  id?: string;

  /** Transaction date (YYYY-MM-DD or DD/MM/YYYY) */
  date: string;

  /** Transaction amount (positive or negative) */
  amount: number;

  /** Transaction description */
  description: string;

  /** Transaction type */
  type: TransactionType;

  /** Reference number (primary) */
  reference?: string;

  /** Reference number (BNC-style alternative) */
  referenceNumber?: string;

  /** Account identifier */
  accountId?: string;

  /** Account name (alternative identifier) */
  accountName?: string;

  /** Balance after transaction */
  balance?: number;

  /** Allow additional bank-specific fields */
  [key: string]: unknown;
}

/**
 * Options for transaction normalization.
 */
export interface NormalizeOptions {
  /**
   * Account identifier to attach to the transaction.
   * Overrides accountId/accountName from the input.
   */
  accountId?: string;

  /**
   * Whether to include the raw transaction in the output.
   * @default true
   */
  includeRaw?: boolean;
}

/**
 * Unified account model
 */
export interface Account {
  /** Account number */
  accountNumber: string;

  /** Account type (e.g., "checking", "savings") */
  accountType: string;

  /** Account balance */
  balance: number;

  /** Currency code (e.g., "VES", "USD") */
  currency: string;

  /** Account status */
  status: string;

  /** Bank name */
  bankName?: string;

  /** Account display name */
  accountName?: string;

  /** Available balance (may differ from balance) */
  availableBalance?: number;
}
