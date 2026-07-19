// Raw per-bank interfaces (the shapes scrapers/HTTP clients emit before
// normalization). The canonical, normalized cross-bank domain model —
// `Account` and `Transaction` with a deterministic `txnKey` — lives in
// `core/types.ts`; use `normalizeTransactions()` to convert these into it.

/**
 * Raw account shape a bank scraper produces. Bank-specific types
 * (`BanescoAccount`, `BncAccount`, `FacebankAccount`) extend this. For the
 * normalized cross-bank account model see `Account` in `core/types.ts`.
 */
export interface BankAccount {
  accountNumber: string;
  accountType: string;
  balance: number;
  currency: string;
  status: string;
  bankName?: string;
  accountName?: string;
  availableBalance?: number;
}

/**
 * Raw transaction row a bank scraper produces. Bank-specific types extend this.
 * For the normalized cross-bank model (positive amount + `txnKey`) see
 * `Transaction` in `core/types.ts`, and `BankTransactionInput` for the
 * normalization input contract.
 */
export interface BankTransaction {
  id?: string;
  date: string;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  reference?: string;
  category?: string;
}

/**
 * @deprecated Use `BaseBankLoginResult` from `shared/types` — it is the shape
 * the `BaseBankAuth` login template actually returns. Kept for back-compat.
 */
export interface LoginResult {
  success: boolean;
  message: string;
  sessionValid: boolean;
  redirectUrl?: string;
}

export interface ScrapingResult<T> {
  success: boolean;
  data?: T[];
  error?: string;
  timestamp?: Date;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface BrowserConfig {
  headless: boolean;
  locale: string;
  timezoneId: string;
  userAgent: string;
  viewport: { width: number; height: number };
}

// Bank configuration
export interface BankConfig {
  name: string;
  code: string;
  baseUrl: string;
  loginUrl: string;
  supportedFeatures: string[];
  locale?: string;
  timezone?: string;
}