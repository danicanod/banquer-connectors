/**
 * Banesco HTTP transport (extracted from BanescoHttpClient).
 *
 * Owns the cookie jar and the low-level fetch plumbing: realistic headers, the
 * Cookie header, Banesco's required Referer/Origin, the request timeout, and
 * Set-Cookie capture. Behavior is identical to the logic that previously lived
 * inline on the client — this is a faithful mechanical extraction, not a
 * reimplementation (it deliberately keeps the hand-rolled cookie handling rather
 * than switching to the shared CookieFetch, which would be behavior-sensitive).
 */

import { parseCookies, serializeCookies } from './form-parser.js';

type Logger = (message: string) => void;
const noop: Logger = () => {};

export interface BanescoTransportConfig {
  userAgent: string;
  timeout: number;
  /** Base site origin, used as the Origin header on POSTs (e.g. https://www.banesconline.com). */
  baseUrl: string;
  /** Login page URL, used as the default Referer on GETs. */
  loginPageUrl: string;
}

export class BanescoTransport {
  private cookies: Map<string, string> = new Map();

  constructor(
    private readonly config: BanescoTransportConfig,
    private readonly log: Logger = noop,
  ) {}

  /** Number of cookies currently held. */
  get cookieCount(): number {
    return this.cookies.size;
  }

  /** Snapshot copy of the current cookies. */
  getCookies(): Map<string, string> {
    return new Map(this.cookies);
  }

  /** Set/overwrite a single cookie. */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** GET a URL and return its body text. */
  async fetchPage(url: string): Promise<string> {
    const response = await this.makeRequest(url, {
      method: 'GET',
      redirect: 'follow'
    });

    return response.text();
  }

  /** POST a form (urlencoded), handling redirects manually so cookies are captured. */
  async postForm(url: string, formData: Record<string, string>): Promise<Response> {
    const response = await this.makeRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(formData).toString(),
      redirect: 'manual' // Handle redirects manually to capture cookies
    });

    // If redirected, follow but first capture any new cookies
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // Cookies are already captured in makeRequest
        // Return the response so caller can handle redirect
      }
    }

    return response;
  }

  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const headers: HeadersInit = {
      'User-Agent': this.config.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'es-US,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': options.method === 'POST' ? 'iframe' : 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      ...(options.headers || {})
    };

    // Add cookies
    if (this.cookies.size > 0) {
      (headers as Record<string, string>)['Cookie'] = serializeCookies(this.cookies);
      this.log(`   [Cookie] Sending: ${serializeCookies(this.cookies).substring(0, 50)}...`);
    }

    // Add Referer for all requests (Banesco validates this)
    // Use the authenticated container page as referer for GET, or the request URL for POST
    if (options.method === 'POST') {
      (headers as Record<string, string>)['Origin'] = this.config.baseUrl;
      (headers as Record<string, string>)['Referer'] = url;
    } else {
      // For GET requests, pretend we're navigating from the authenticated dashboard
      (headers as Record<string, string>)['Referer'] = this.config.loginPageUrl;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      this.log(`   [${options.method || 'GET'}] ${url.substring(url.lastIndexOf('/') + 1)}`);

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Capture cookies from response - handle multiple Set-Cookie headers
      // Node.js fetch combines them with ", " but we need to parse carefully
      const setCookieRaw = response.headers.get('set-cookie');
      if (setCookieRaw) {
        // Split by ", " but be careful with expires dates that also contain ", "
        // Each cookie typically starts with a name= pattern
        const cookieParts = setCookieRaw.split(/,(?=[A-Za-z_][A-Za-z0-9_]*=)/);
        for (const part of cookieParts) {
          const newCookies = parseCookies(part.trim());
          newCookies.forEach((value, name) => {
            this.cookies.set(name, value);
            this.log(`   [Cookie] Set: ${name}=${value.substring(0, 20)}...`);
          });
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
}
