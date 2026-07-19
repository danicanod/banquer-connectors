// Base interfaces for all bank scrapers

export interface BankCredentials {
  username: string;
  password: string;
  securityQuestions?: string;
  additionalFields?: Record<string, string>;
}

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

export interface BankTransaction {
  id?: string;
  date: string;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  reference?: string;
  category?: string;
}

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

// Base interface for bank scrapers
export interface BankScraper {
  login(): Promise<LoginResult>;
  scrapeAccounts(): Promise<ScrapingResult<BankAccount>>;
  scrapeTransactions(accountUrl?: string): Promise<ScrapingResult<BankTransaction>>;
  close(): Promise<void>;
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

export enum SupportedBanks {
  BANESCO = 'banesco',
  BNC = 'bnc',
  FACEBANK = 'facebank',
  // Future banks can be added here
  // BOD = 'bod',
  // MERCANTIL = 'mercantil'
} 