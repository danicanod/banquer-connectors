/**
 * Shared types for banking scrapers
 */

import { PERFORMANCE_PRESETS } from '../performance-config.js';

// Shared types for all bank implementations
export * from './base.js';

// Note: the canonical `Account`/`Transaction` names belong to `core/types.ts`
// (the normalized cross-bank model). The raw per-bank shapes are exported here
// as `BankAccount`/`BankTransaction` — do NOT re-alias them to `Account`/
// `Transaction`, which previously collided with the core types of the same name.

// Base authentication configuration that all banks should support
export interface BaseBankAuthConfig {
  headless?: boolean;      // Default: false
  timeout?: number;        // Default: 30000ms
  debug?: boolean;         // Default: false
  saveSession?: boolean;   // Default: true
  /**
   * When debug is on, pause the flow with the Playwright Inspector
   * (`page.pause()`) at each checkpoint. Set false for attended flows to log
   * checkpoints without halting. Default: true.
   */
  pauseOnDebug?: boolean;
  /**
   * When set, connect to a remote browser over the Chrome DevTools Protocol
   * (e.g. a Browserbase session's `connectUrl`) instead of launching a local
   * Chromium. In this mode the remote session controls user-agent, locale,
   * timezone and viewport — those `launch`/`newContext` options are ignored.
   */
  browserWSEndpoint?: string;
  // Performance optimization options
  performancePreset?: keyof typeof PERFORMANCE_PRESETS;
  performance?: {
    blockCSS?: boolean;
    blockImages?: boolean;
    blockFonts?: boolean;
    blockMedia?: boolean;
    blockNonEssentialJS?: boolean;
    blockAds?: boolean;
    blockAnalytics?: boolean;
  };
}

// Base authentication result interface
export interface BaseBankLoginResult {
  success: boolean;
  message: string;
  sessionValid: boolean;
  error?: string;
}

// Base bank credentials interface (can be extended by specific banks)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BaseBankCredentials {
  // Common fields that all banks might have
  // Specific banks can extend this interface
}

// Base scraping configuration interface
export interface BaseBankScrapingConfig {
  debug?: boolean;         // Default: false
  timeout?: number;        // Default: 30000ms
  waitBetweenActions?: number;  // Default: 1000ms
  retries?: number;        // Default: 3
  saveHtml?: boolean;      // Default: false
}

// Base scraping result interface
export interface BaseBankScrapingResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T[];
  timestamp: Date;
  error?: string;
  metadata?: Record<string, unknown>;
}
