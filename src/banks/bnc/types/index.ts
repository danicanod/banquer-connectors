// Centralized types for BNC scraper

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
  BankAccount as Account,
  BankTransaction as Transaction
} from '../../../shared/types/index.js';

// BNC-specific credentials (3-step authentication) - extends base
export interface BncCredentials extends BaseBankCredentials {
  id: string;        // Cédula de identidad
  card: string;      // Número de tarjeta
  password: string;  // Contraseña
}

// Alias for backward compatibility with other bank patterns
export type BNCCredentials = BncCredentials;

// BNC authentication configuration - extends base
export interface BncAuthConfig extends BaseBankAuthConfig {
  retries?: number;      // BNC-specific: retry attempts
}

// BNC scraping configuration - extends base
export interface BncScrapingConfig extends BaseBankScrapingConfig {
  maxAccounts?: number;  // BNC-specific: limit accounts to scrape
}

// BNC-specific extensions
export interface BncAccount extends BankAccount {
  bankName: 'BNC';
  accountCode?: string; // Internal BNC account code
}

export interface BncTransaction extends BankTransaction {
  bankName?: 'BNC';
  transactionType?: string;
  referenceNumber?: string;
  accountName?: string;    // Account name for multi-account support
}

// BNC URLs and constants
export const BNC_URLS = {
  BASE: 'https://personas.bncenlinea.com',
  LOGIN: 'https://personas.bncenlinea.com/',
  TRANSACTIONS: 'https://personas.bncenlinea.com/Accounts/Transactions/Last25'
};

export const BNC_SELECTORS = {
  // Login selectors
  CARD_NUMBER: '#CardNumber',
  USER_ID: '#UserID', 
  PASSWORD: '#UserPassword',
  SUBMIT_BUTTON: 'button#BtnSend',
  LOGOUT_BUTTON: '#btn-logout',
  
  // Transaction selectors
  FILTER_BUTTON: '#PnlFilter > div.card.container-card.rounded > div.card-body > div > div.col-12.col-md-8.pb-4.pb-md-2 > div.form-label-floating > div > button',
  SEARCH_BUTTON: '#PnlFilter > div.card.container-card.rounded > div.card-body > div > div.col-12.offset-md-0.col-md-4.pb-md-2 > button',
  DROPDOWN_ICON: '#Tbl_Transactions > tbody > tr > td:nth-child(6) > i',
  
  // Transaction data selectors
  TRANSACTION_DATE: '#Tbl_Transactions > tbody > tr.cursor-pointer > td:nth-child(1)',
  TRANSACTION_TYPE: '#Tbl_Transactions > tbody > tr.cursor-pointer > td:nth-child(2)',
  TRANSACTION_REFERENCE: '#Tbl_Transactions > tbody > tr.cursor-pointer > td:nth-child(3)',
  TRANSACTION_AMOUNT: '#Tbl_Transactions > tbody > tr.cursor-pointer > td:nth-child(4)',
  TRANSACTION_DESCRIPTION: '#Tbl_Transactions > tbody > tr.no-padding > td > div > div > div > div.font-weight-normal.pl-md-2.SHD > div > div.SHD.font-size-custom.pb-1',
  
  // Modal selectors
  LOGOUT_MODAL: '#Mdl-Confirm',
  LOGOUT_CONFIRM: '#Mdl-Confirm-Yes'
};

// BNC configuration
export const BNC_CONFIG: BankConfig = {
  name: 'BNC',
  code: 'bnc',
  baseUrl: BNC_URLS.BASE,
  loginUrl: BNC_URLS.LOGIN,
  supportedFeatures: ['accounts', 'transactions'],
  locale: 'es-VE',
  timezone: 'America/Caracas'
};

// BNC login result with additional properties
export interface BncLoginResult extends BaseBankLoginResult {
  sessionCookies?: string[];
  userInfo?: {
    id: string;
    cardNumber: string;
  };
}

// BNC scraping result interface - extends base
export interface BncScrapingResult extends BaseBankScrapingResult<BncTransaction> {
  bankName: 'BNC';
  accountsFound?: number;
  transactionsExtracted?: number;
  sessionInfo?: {
    loginTime: string;
    lastActivity: string;
  };
} 