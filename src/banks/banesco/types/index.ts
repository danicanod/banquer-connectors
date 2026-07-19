// Centralized types for Banesco scraper

import { 
  BankAccount, 
  BankTransaction, 
  BankConfig,
  BaseBankAuthConfig,
  BaseBankLoginResult,
  BaseBankCredentials,
  BaseBankScrapingConfig,
  BaseBankScrapingResult
} from '../../../shared/types/index.js';

// Re-export base types for convenience
export type {
  LoginResult,
  ScrapingResult,
  BrowserConfig
} from '../../../shared/types/index.js';

// Banesco-specific credentials with required security questions - extends base
export interface BanescoCredentials extends BaseBankCredentials {
  username: string;
  password: string;
  securityQuestions: string; // Required for Banesco
}

// Banesco authentication configuration - extends base
export interface BanescoAuthConfig extends BaseBankAuthConfig {
  /** Number of retries for transient Banesco outages (default: 0 = no retry) */
  loginRetries?: number;
  /** Delay in ms between retries (default: 5000) */
  loginRetryDelayMs?: number;
}

// Banesco scraping configuration - extends base
export interface BanescoScrapingConfig extends BaseBankScrapingConfig {
  extractAccountSummary?: boolean;  // Banesco-specific: extract balance info
}

// Banesco-specific extensions
export interface BanescoAccount extends BankAccount {
  bankName: 'Banesco';
}

export interface BanescoTransaction extends BankTransaction {
  bankName?: 'Banesco';
  accountName?: string;    // Account name for multi-account support
}

export interface BanescoSecurityQuestion {
  question: string;
  answer: string;
  fieldName: string;
}

// Banesco URLs and constants.
// Path casing is kept exactly as the working flow uses it: IIS paths are
// case-insensitive, so LOGIN's lowercase and the mixed-case app paths both resolve.
export const BANESCO_URLS = {
  BASE: 'https://www.banesconline.com',
  LOGIN: 'https://www.banesconline.com/mantis/Website/Login.aspx',
  DASHBOARD: 'https://www.banesconline.com/Mantis/WebSite/Default.aspx',
  MOVEMENTS:
    'https://www.banesconline.com/Mantis/WebSite/ConsultaMovimientosCuenta/MovimientosCuenta.aspx',
  IFRAME_SELECTOR: 'iframe#ctl00_cp_frmAplicacion'
};

/** ASP.NET label/input id pairs for Banesco's up-to-4 security-question slots. */
export interface SecurityQuestionSlot {
  labelId: string;
  inputId: string;
}

/** The four fixed security-question slots (single source of truth for auth + parser). */
export const SECURITY_QUESTION_SLOTS: SecurityQuestionSlot[] = [
  { labelId: 'lblPrimeraP', inputId: 'txtPrimeraR' },
  { labelId: 'lblSegundaP', inputId: 'txtSegundaR' },
  { labelId: 'lblTerceraP', inputId: 'txtTerceraR' },
  { labelId: 'lblCuartaP', inputId: 'txtCuartaR' },
];

// Banesco configuration
export const BANESCO_CONFIG: BankConfig = {
  name: 'Banesco',
  code: 'banesco',
  baseUrl: 'https://www.banesconline.com',
  loginUrl: 'https://www.banesconline.com/mantis/Website/Login.aspx',
  supportedFeatures: ['accounts', 'transactions', 'security-questions'],
  locale: 'es-VE',
  timezone: 'America/Caracas'
};

export interface SecurityQuestionMap {
  [keyword: string]: string;
}

// Banesco login result with additional properties - extends base
export interface BanescoLoginResult extends BaseBankLoginResult {
  sessionCookies?: string[];
  systemMessage?: string;
}

// Banesco scraping result interface - extends base
export interface BanescoScrapingResult extends BaseBankScrapingResult<BanescoTransaction> {
  bankName: 'Banesco';
  accountSummary?: {
    currentBalance: number | null;
    previousBalance: number | null;
    accountNumber: string | null;
    accountType: string | null;
  };
} 