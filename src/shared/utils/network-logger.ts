/**
 * Network Logger Utility
 * 
 * Captures HTTP requests and responses during Playwright sessions
 * for analysis of bank authentication flows.
 */

import { Page, Request, Response } from 'playwright';
import { writeFileSync } from 'fs';

export interface CapturedRequest {
  timestamp: string;
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  postData?: string;
  postDataFields?: Record<string, string>;
}

export interface CapturedResponse {
  timestamp: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType?: string;
}

export interface NetworkLogEntry {
  request: CapturedRequest;
  response?: CapturedResponse;
}

export interface NetworkLoggerConfig {
  logToConsole?: boolean;
  outputPath?: string;
  filterEssentialOnly?: boolean;
  redactSensitive?: boolean;
  sensitiveFields?: string[];
}

const sensitiveFieldPatterns = [
  'password', 'clave', 'txtClave', 'txtPassword', 'pwd', 'pass',
  'token', 'authorization', 'auth', 'secret', 'key', 'apikey',
  'cookie', 'session', 'csrf', '__VIEWSTATE', '__EVENTVALIDATION'
];

export class NetworkLogger {
  private entries: NetworkLogEntry[] = [];
  private config: Required<NetworkLoggerConfig>;
  private requestMap: Map<string, CapturedRequest> = new Map();

  constructor(config: NetworkLoggerConfig = {}) {
    this.config = {
      logToConsole: false,
      outputPath: `network-capture-${Date.now()}.json`,
      filterEssentialOnly: true,
      redactSensitive: true,
      sensitiveFields: [...sensitiveFieldPatterns, ...(config.sensitiveFields || [])],
      ...config
    };
  }

  attach(page: Page): void {
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => this.onResponse(response));
    
    if (this.config.logToConsole) {
      console.log('[NetworkLogger] attached');
    }
  }

  private shouldCapture(resourceType: string): boolean {
    if (!this.config.filterEssentialOnly) return true;
    const essentialTypes = ['document', 'xhr', 'fetch', 'script'];
    return essentialTypes.includes(resourceType);
  }

  private redactValue(key: string, value: string): string {
    if (!this.config.redactSensitive) return value;
    
    const keyLower = key.toLowerCase();
    const shouldRedact = this.config.sensitiveFields.some(field => 
      keyLower.includes(field.toLowerCase())
    );
    
    if (shouldRedact && value.length > 0) {
      if (value.length > 10) {
        return `${value.substring(0, 3)}***${value.substring(value.length - 3)}`;
      }
      return '***';
    }
    
    return value;
  }

  private redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      redacted[key] = this.redactValue(key, value);
    }
    return redacted;
  }

  private parsePostData(postData: string | null): Record<string, string> | undefined {
    if (!postData) return undefined;
    
    try {
      const params = new URLSearchParams(postData);
      const fields: Record<string, string> = {};
      
      for (const [key, value] of params.entries()) {
        fields[key] = this.redactValue(key, value);
      }
      
      return Object.keys(fields).length > 0 ? fields : undefined;
    } catch {
      return undefined;
    }
  }

  private onRequest(request: Request): void {
    const resourceType = request.resourceType();
    if (!this.shouldCapture(resourceType)) return;
    
    const url = request.url();
    const method = request.method();
    const headers = request.headers();
    const postData = request.postData();
    
    const captured: CapturedRequest = {
      timestamp: new Date().toISOString(),
      url,
      method,
      resourceType,
      headers: this.redactHeaders(headers),
      postData: postData ? (this.config.redactSensitive ? undefined : postData) : undefined,
      postDataFields: this.parsePostData(postData)
    };
    
    this.requestMap.set(`${method}:${url}`, captured);
    
    if (this.config.logToConsole) {
      console.log(`[REQ] ${method} ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
    }
  }

  private onResponse(response: Response): void {
    const request = response.request();
    const resourceType = request.resourceType();
    if (!this.shouldCapture(resourceType)) return;
    
    const url = response.url();
    const method = request.method();
    const status = response.status();
    const statusText = response.statusText();
    const headers = response.headers();
    
    const captured: CapturedResponse = {
      timestamp: new Date().toISOString(),
      url,
      status,
      statusText,
      headers: this.redactHeaders(headers),
      contentType: headers['content-type']
    };
    
    const requestKey = `${method}:${url}`;
    const matchedRequest = this.requestMap.get(requestKey);
    
    if (matchedRequest) {
      this.entries.push({ request: matchedRequest, response: captured });
      this.requestMap.delete(requestKey);
    } else {
      this.entries.push({
        request: {
          timestamp: captured.timestamp,
          url,
          method,
          resourceType,
          headers: {}
        },
        response: captured
      });
    }
    
    if (this.config.logToConsole) {
      console.log(`[RES] ${status} ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
    }
  }

  getEntries(): NetworkLogEntry[] {
    return [...this.entries];
  }

  getSummary(): { 
    totalRequests: number;
    documents: number;
    xhrFetch: number;
    postRequests: number;
    authRelated: string[];
  } {
    const documents = this.entries.filter(e => e.request.resourceType === 'document').length;
    const xhrFetch = this.entries.filter(e => ['xhr', 'fetch'].includes(e.request.resourceType)).length;
    const postRequests = this.entries.filter(e => e.request.method === 'POST').length;
    
    const authKeywords = ['login', 'auth', 'session', 'contrasena', 'clave', 'password'];
    const authRelated = this.entries
      .filter(e => authKeywords.some(kw => e.request.url.toLowerCase().includes(kw)))
      .map(e => `${e.request.method} ${new URL(e.request.url).pathname}`);
    
    return {
      totalRequests: this.entries.length,
      documents,
      xhrFetch,
      postRequests,
      authRelated: [...new Set(authRelated)]
    };
  }

  save(outputPath?: string): string {
    const path = outputPath || this.config.outputPath;
    
    const output = {
      capturedAt: new Date().toISOString(),
      summary: this.getSummary(),
      entries: this.entries
    };
    
    writeFileSync(path, JSON.stringify(output, null, 2));
    
    if (this.config.logToConsole) {
      console.log(`[NetworkLogger] saved to: ${path} (${this.entries.length} entries)`);
    }
    
    return path;
  }

  clear(): void {
    this.entries = [];
    this.requestMap.clear();
  }
}

export function createNetworkLogger(page: Page, config?: NetworkLoggerConfig): NetworkLogger {
  const logger = new NetworkLogger(config);
  logger.attach(page);
  return logger;
}
