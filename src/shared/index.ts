// Shared base classes and types for all bank implementations

// Base classes
export { BaseBankAuth } from './base-bank-auth.js';

// HTTP Client utilities
export {
  CookieFetch,
  createCookieFetch,
  extractRequestVerificationToken
} from './utils/http-client.js';
export type { HttpClientConfig, RequestOptions, FormPostResult } from './utils/http-client.js';

// Interactive input utilities (e.g. OTP prompts for interactive/CLI flows)
export { promptForInput } from './utils/interactive.js';

// Base types
export type {
  BaseBankAuthConfig,
  BaseBankLoginResult,
  BaseBankCredentials,
  BaseBankScrapingConfig,
  BaseBankScrapingResult
} from './types/index.js';

// Re-export all shared types for convenience
export * from './types/index.js'; 