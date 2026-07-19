// Centralized types for the Facebank (PR) connector.
//
// Facebank's online banking (https://secureib.facebank.pr) is a COBIS CWC
// Angular single-page app backed by AWS Cognito. Login is JWT/token-based
// (not cookie-based) and runs through a small sequence of JSON APIs; the
// connector drives it with Playwright (the page handles credential encoding,
// captcha and token storage) then reads account data with the session token.

import {
  BankAccount,
  BankTransaction,
  BankConfig,
  BaseBankAuthConfig,
  BaseBankLoginResult,
  BaseBankCredentials,
  BaseBankScrapingResult,
} from '../../../shared/types/index.js';

// Re-export base types for convenience (mirrors banesco/bnc)
export type {
  BankAccount as Account,
  BankTransaction as Transaction,
} from '../../../shared/types/index.js';

/**
 * Facebank credentials.
 *
 * `username`/`password` are always required. The security-image challenge
 * (`secretImage` + `secretWord`) is a conditional step-up screen that a fresh
 * client rarely sees — supply them only if your account triggers it. They map
 * to COBIS's `imagenid` (which registered image is yours) and `alias` (the
 * secret word tied to it); the image step is therefore automatable by value,
 * not by visual recognition.
 */
export interface FacebankCredentials extends BaseBankCredentials {
  username: string;
  password: string;
  /** Secret word/alias tied to your security image (COBIS `alias`). */
  secretWord?: string;
  /** Identifier of your registered security image (COBIS `imagenid`). */
  secretImage?: string | number;
}

/**
 * Facebank auth configuration.
 *
 * Adds an OTP provider on top of the shared browser options. The one-time code
 * is emailed at login (5 characters, ~5 min validity); `otpProvider` supplies
 * it programmatically, and when omitted the connector falls back to an
 * interactive terminal prompt (requires a TTY and `headless: false` is
 * recommended so you can watch the flow).
 */
export interface FacebankAuthConfig extends BaseBankAuthConfig {
  /**
   * Supplies the one-time 2FA code. Called after Facebank emails the code.
   * If omitted (and `manualOtp` is off), the connector prompts for it on the
   * terminal (stdin).
   */
  otpProvider?: () => Promise<string>;
  /**
   * Manual OTP mode (headed sessions): instead of typing the code for you, the
   * connector waits for YOU to enter the emailed code directly in the browser
   * window and detects when login advances. Ignored when `otpProvider` is set.
   * Default: false.
   */
  manualOtp?: boolean;
  /**
   * If the (rare) security-image screen appears and cannot be auto-handled,
   * pause for the user to complete it manually in a headed browser instead of
   * failing. Default: true.
   */
  manualImageFallback?: boolean;
}

// Facebank-specific domain models (extend the shared base)
export interface FacebankAccount extends BankAccount {
  bankName: 'Facebank';
}

export interface FacebankTransaction extends BankTransaction {
  bankName?: 'Facebank';
  /** Owning account number, for multi-account results. */
  accountName?: string;
}

/** Facebank login result (extends the shared base result). */
export interface FacebankLoginResult extends BaseBankLoginResult {
  /** Whether the security-image step-up screen was encountered. */
  imageChallengeSeen?: boolean;
}

/** Facebank scraping result. */
export interface FacebankScrapingResult extends BaseBankScrapingResult<FacebankTransaction> {
  bankName: 'Facebank';
  accountsFound?: number;
  transactionsExtracted?: number;
}

/** Result of listing accounts. */
export interface FacebankAccountsResult {
  success: boolean;
  message: string;
  accounts: FacebankAccount[];
  error?: string;
}

/** Result of reading movements for an account. */
export interface FacebankMovementsResult {
  success: boolean;
  message: string;
  accountNumber?: string;
  transactions: FacebankTransaction[];
  error?: string;
}

// ============================================================================
// URLs and constants (confirmed via recon)
// ============================================================================

export const FACEBANK_URLS = {
  BASE: 'https://secureib.facebank.pr',
  LOGIN: 'https://secureib.facebank.pr/personas/banca-virtual#!/login',
  /** COBIS CWC JSON API root. */
  API_BASE: 'https://secureib.facebank.pr/personas/services/resources/cobis/cwc',
} as const;

/** Hash routes of the SPA login flow (used to detect the current step). */
export const FACEBANK_ROUTES = {
  LOGIN: '#!/login',
  OTP: '#!/otp',
  HOME: '#!/home',
} as const;

/** DOM selectors for the login and OTP screens (confirmed via recon). */
export const FACEBANK_SELECTORS = {
  USERNAME: '#username',
  PASSWORD: '#password',
  LOGIN_BUTTON: '#btnLogin',
  OTP_CODE: '#codigo',
  OTP_SUBMIT: '#btn-continuar',
  OTP_RESEND: '#codeOtp',
} as const;

export const FACEBANK_CONFIG: BankConfig = {
  name: 'Facebank',
  code: 'facebank',
  baseUrl: FACEBANK_URLS.BASE,
  loginUrl: FACEBANK_URLS.LOGIN,
  supportedFeatures: ['accounts', 'transactions', 'otp', 'security-image'],
  locale: 'es-VE',
  timezone: 'America/Caracas',
};
