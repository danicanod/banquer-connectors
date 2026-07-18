// Shared base classes and types for all bank implementations

// Base classes
export { BaseBankAuth } from './base-bank-auth.js';

// Utilities
export { NetworkLogger, createNetworkLogger } from './utils/network-logger.js';
export type { NetworkLogEntry, NetworkLoggerConfig, CapturedRequest, CapturedResponse } from './utils/network-logger.js';

// HTTP Client utilities
export { 
  CookieFetch, 
  createCookieFetch,
  extractRequestVerificationToken,
  extractAspNetFields,
  extractTableData,
  parseJsonResponse
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