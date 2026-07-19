/**
 * Shared HTTP Client Utilities
 * 
 * Provides common HTTP functionality for bank scrapers:
 * - Cookie jar management with tough-cookie
 * - Form POST helpers
 * - Token extraction (CSRF, ASP.NET hidden fields)
 * - Standardized headers matching Playwright defaults
 * 
 * ## CookieFetch
 * 
 * The main class for making HTTP requests with automatic session management:
 * ```typescript
 * const http = createCookieFetch({ debug: true });
 * const html = await http.getHtml('https://example.com/login');
 * await http.postForm('https://example.com/auth', { user: 'foo', pass: 'bar' });
 * ```
 * 
 * ## Token Extraction
 * 
 * Helper functions for common authentication patterns:
 * - `extractRequestVerificationToken()` - ASP.NET MVC CSRF tokens
 * - `extractAspNetFields()` - WebForms hidden fields (__VIEWSTATE, etc.)
 * - `extractTableData()` - Parse HTML tables for transaction data
 * 
 * @see {@link CookieFetch} - Main HTTP client class
 * @see {@link createCookieFetch} - Factory function
 */

import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';

// ============================================================================
// Types
// ============================================================================

export interface HttpClientConfig {
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Custom user agent */
  userAgent?: string;
  /** Accept language header */
  acceptLanguage?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}

export interface FormPostResult {
  response: Response;
  html: string;
  location?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'es-VE';

// ============================================================================
// CookieFetch - Fetch wrapper with cookie jar
// ============================================================================

export class CookieFetch {
  private cookieJar: CookieJar;
  private config: Required<HttpClientConfig>;
  private debugEnabled: boolean;

  constructor(config: HttpClientConfig = {}) {
    this.cookieJar = new CookieJar();
    this.config = {
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
      acceptLanguage: config.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE
    };
    this.debugEnabled = this.config.debug;
  }

  /**
   * Make an HTTP request with automatic cookie handling
   */
  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    
    // Build headers with cookies
    const headers: Record<string, string> = {
      'User-Agent': this.config.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': this.config.acceptLanguage,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': '"Not.A/Brand";v="99", "Chromium";v="136"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      ...(options.headers || {})
    };

    // Add cookies from jar
    const cookieString = await this.cookieJar.getCookieString(url);
    if (cookieString) {
      headers['Cookie'] = cookieString;
      this.log(`   [Cookie] Sending: ${cookieString.substring(0, 60)}...`);
    }

    // Add content-type for POST
    if (method === 'POST' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }

    // Add XHR header for POST requests (common in AJAX-based logins)
    if (method === 'POST') {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    // Setup timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      this.log(`   [${method}] ${url}`);

      const response = await fetch(url, {
        method,
        headers,
        body: options.body,
        redirect: options.redirect ?? 'follow',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Capture cookies from response
      const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
      for (const header of setCookieHeaders) {
        try {
          await this.cookieJar.setCookie(header, url);
          const cookie = Cookie.parse(header);
          if (cookie) {
            this.log(`   [Cookie] Set: ${cookie.key}=${cookie.value.substring(0, 20)}...`);
          }
        } catch {
          // Ignore invalid cookies
        }
      }

      this.log(`   [Response] ${response.status} ${response.statusText}`);

      return response;

    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * GET request that returns HTML
   */
  async getHtml(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await this.request(url, { method: 'GET', headers });
    return response.text();
  }

  /**
   * POST form data and return result
   */
  async postForm(url: string, formData: Record<string, string>, headers?: Record<string, string>): Promise<FormPostResult> {
    const body = new URLSearchParams(formData).toString();
    
    const response = await this.request(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual' // Handle redirects manually to capture cookies
    });

    const location = response.headers.get('location') || undefined;
    const html = await response.text();

    return { response, html, location };
  }

  /**
   * Get all cookies for a URL
   */
  async getCookies(url: string): Promise<Cookie[]> {
    return this.cookieJar.getCookies(url);
  }

  /**
   * Get cookie string for a URL
   */
  async getCookieString(url: string): Promise<string> {
    return this.cookieJar.getCookieString(url);
  }

  /**
   * Set a cookie manually
   */
  async setCookie(cookie: string, url: string): Promise<void> {
    await this.cookieJar.setCookie(cookie, url);
  }

  /**
   * Clear all cookies
   */
  async clearCookies(): Promise<void> {
    this.cookieJar = new CookieJar();
  }

  /**
   * Enable/disable debug logging
   */
  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  private log(message: string): void {
    if (this.debugEnabled) {
      console.log(`[HTTP] ${message}`);
    }
  }
}

// ============================================================================
// Token Extraction Utilities
// ============================================================================

/**
 * Extract __RequestVerificationToken from HTML (for ASP.NET MVC CSRF protection).
 * 
 * Tries multiple strategies:
 * 1. Input field: `<input name="__RequestVerificationToken" value="..." />`
 * 2. Meta tag: `<meta name="__RequestVerificationToken" content="..." />`
 * 3. Regex fallback for malformed HTML
 * 
 * @param html - Raw HTML string from the page
 * @returns The token value, or null if not found
 * 
 * @example
 * ```typescript
 * const html = await http.getHtml('https://bank.com/login');
 * const token = extractRequestVerificationToken(html);
 * await http.postForm('/auth', { __RequestVerificationToken: token, ... });
 * ```
 */
export function extractRequestVerificationToken(html: string): string | null {
  const $ = cheerio.load(html);
  
  // Try input field first
  const inputToken = $('input[name="__RequestVerificationToken"]').val() as string;
  if (inputToken) {
    return inputToken;
  }

  // Try meta tag
  const metaToken = $('meta[name="__RequestVerificationToken"]').attr('content');
  if (metaToken) {
    return metaToken;
  }

  // Try regex as fallback
  const match = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (match) {
    return match[1];
  }

  return null;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new CookieFetch instance
 */
export function createCookieFetch(config?: HttpClientConfig): CookieFetch {
  return new CookieFetch(config);
}
