/**
 * ASP.NET WebForms Parser
 * 
 * Utility for parsing ASP.NET WebForms pages using Cheerio.
 * Extracts __VIEWSTATE, __EVENTVALIDATION, hidden fields, and form data.
 */

import * as cheerio from 'cheerio';
import { SECURITY_QUESTION_SLOTS } from '../types/index.js';

export interface AspNetFormFields {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
  [key: string]: string;
}

export interface SecurityQuestion {
  labelId: string;
  inputId: string;
  questionText: string;
}

export interface ParsedLoginPage {
  formFields: AspNetFormFields;
  formAction: string;
  allHiddenFields: Record<string, string>;
}

export interface ParsedSecurityQuestionsPage {
  formFields: AspNetFormFields;
  formAction: string;
  questions: SecurityQuestion[];
  questionCount: number;
  allHiddenFields: Record<string, string>;
}

export interface ParsedPasswordPage {
  formFields: AspNetFormFields;
  formAction: string;
  allHiddenFields: Record<string, string>;
}

/** Coerce cheerio's `.val()` (string | string[] | undefined) to a plain string. */
function valToString(v: string | string[] | undefined | null): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse ASP.NET WebForms hidden fields from HTML
 */
export function parseAspNetFormFields(html: string): AspNetFormFields {
  const $ = cheerio.load(html);

  const viewState = valToString($('input[name="__VIEWSTATE"]').val());
  const viewStateGenerator = valToString($('input[name="__VIEWSTATEGENERATOR"]').val());
  const eventValidation = valToString($('input[name="__EVENTVALIDATION"]').val());
  
  return {
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    __EVENTVALIDATION: eventValidation
  };
}

/**
 * Parse all hidden input fields from HTML
 */
export function parseAllHiddenFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  
  $('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name');
    const value = valToString($(element).val());
    if (name) {
      fields[name] = value;
    }
  });
  
  return fields;
}

/**
 * Parse the Banesco login page (username step)
 */
export function parseLoginPage(html: string): ParsedLoginPage {
  const $ = cheerio.load(html);
  
  const formFields = parseAspNetFormFields(html);
  const allHiddenFields = parseAllHiddenFields(html);
  
  // Get form action (or default)
  const formAction = $('form').attr('action') || '';
  
  return {
    formFields,
    formAction,
    allHiddenFields
  };
}

/**
 * Parse the Banesco security questions page
 */
export function parseSecurityQuestionsPage(html: string): ParsedSecurityQuestionsPage {
  const $ = cheerio.load(html);
  
  const formFields = parseAspNetFormFields(html);
  const allHiddenFields = parseAllHiddenFields(html);
  const formAction = $('form').attr('action') || '';
  
  // Parse security questions
  const questionElements = SECURITY_QUESTION_SLOTS;
  
  const questions: SecurityQuestion[] = [];
  
  for (const element of questionElements) {
    // Try different ID patterns (ASP.NET can have prefixes)
    const labelSelectors = [
      `#${element.labelId}`,
      `#ctl00_cp_${element.labelId}`,
      `[id$="${element.labelId}"]`
    ];
    
    let questionText = '';
    
    for (const selector of labelSelectors) {
      const labelElement = $(selector);
      if (labelElement.length > 0) {
        questionText = labelElement.text().trim();
        break;
      }
    }
    
    if (questionText) {
      questions.push({
        labelId: element.labelId,
        inputId: element.inputId,
        questionText
      });
    }
  }
  
  // Get question count from hidden field
  const questionCount = parseInt(allHiddenFields['ContadorPreguntas'] || '0', 10) || questions.length;
  
  return {
    formFields,
    formAction,
    questions,
    questionCount,
    allHiddenFields
  };
}

/**
 * Parse the Banesco password page
 */
export function parsePasswordPage(html: string): ParsedPasswordPage {
  const $ = cheerio.load(html);
  
  const formFields = parseAspNetFormFields(html);
  const allHiddenFields = parseAllHiddenFields(html);
  const formAction = $('form').attr('action') || '';
  
  return {
    formFields,
    formAction,
    allHiddenFields
  };
}

/**
 * Parse the authenticated dashboard page
 */
export function parseDashboardPage(html: string): {
  isAuthenticated: boolean;
  userName?: string;
  menuLinks: { text: string; href: string }[];
} {
  const $ = cheerio.load(html);
  
  // Check for logout link or user info as authentication indicator
  const hasLogoutLink = $('a[href*="salir"], a[href*="logout"], #lnkSalir').length > 0;
  const hasUserMenu = $('#ctl00_lblUsuario, [id*="Usuario"], [id*="Nombre"]').length > 0;
  
  const isAuthenticated = hasLogoutLink || hasUserMenu;
  
  // Try to get username
  const userName = $('#ctl00_lblUsuario').text().trim() || undefined;
  
  // Parse menu links
  const menuLinks: { text: string; href: string }[] = [];
  $('a[href*="aspx"]').each((_, element) => {
    const text = $(element).text().trim();
    const href = $(element).attr('href') || '';
    if (text && href && !href.includes('salir') && !href.includes('logout')) {
      menuLinks.push({ text, href });
    }
  });
  
  return {
    isAuthenticated,
    userName,
    menuLinks
  };
}

/**
 * Parse transactions table from HTML
 */
export function parseTransactionsTable(html: string): {
  headers: string[];
  rows: string[][];
  tableFound: boolean;
} {
  const $ = cheerio.load(html);
  
  // Try to find transaction tables
  const tables = $('table');
  
  if (tables.length === 0) {
    return { headers: [], rows: [], tableFound: false };
  }
  
  // Find tables that look like transaction tables
  let transactionTable: ReturnType<typeof $> | null = null;
  
  tables.each((_, el) => {
    const $el = $(el);
    const headerText = $el.find('th, tr:first-child td').text().toLowerCase();
    if (headerText.includes('fecha') || headerText.includes('monto') || headerText.includes('descripción')) {
      transactionTable = $el;
      return false; // break
    }
  });
  
  if (!transactionTable) {
    // Fall back to first table with more than 1 row
    transactionTable = tables.filter((_, el) => {
      return $(el).find('tr').length > 1; 
    }).first();
  }
  
  if (!transactionTable || transactionTable.length === 0) {
    return { headers: [], rows: [], tableFound: false };
  }
  
  // Extract headers
  const headers: string[] = [];
  transactionTable.find('tr:first-child th, tr:first-child td').each((_, el) => {
    headers.push($(el).text().trim());
  });
  
  // Extract rows
  const rows: string[][] = [];
  transactionTable.find('tr').slice(1).each((_, rowEl) => {
    const rowData: string[] = [];
    $(rowEl).find('td').each((_, cellEl) => {
      rowData.push($(cellEl).text().trim());
    });
    if (rowData.length > 0) {
      rows.push(rowData);
    }
  });
  
  return {
    headers,
    rows,
    tableFound: true
  };
}

/**
 * Extract cookies from Set-Cookie header(s)
 */
export function parseCookies(setCookieHeaders: string | string[] | null): Map<string, string> {
  const cookies = new Map<string, string>();
  
  if (!setCookieHeaders) return cookies;
  
  const headerArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  
  for (const header of headerArray) {
    // Parse "name=value; path=/; ..." format
    const parts = header.split(';');
    if (parts.length > 0) {
      const [nameValue] = parts;
      const equalsIndex = nameValue.indexOf('=');
      if (equalsIndex > 0) {
        const name = nameValue.substring(0, equalsIndex).trim();
        const value = nameValue.substring(equalsIndex + 1).trim();
        cookies.set(name, value);
      }
    }
  }
  
  return cookies;
}

/**
 * Serialize cookies map to Cookie header string
 */
export function serializeCookies(cookies: Map<string, string>): string {
  const parts: string[] = [];
  cookies.forEach((value, name) => {
    parts.push(`${name}=${value}`);
  });
  return parts.join('; ');
}

/**
 * Build the "huella" (fingerprint) string that Banesco expects
 */
export function buildHuella(): string {
  // Simulates browser fingerprint data
  const appCodeName = 'Netscape';
  const appVersion = '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const platform = 'MacIntel';
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const screenHeight = 1117;
  const screenWidth = 1728;
  const colorDepth = 30;
  const availWidth = 1728;
  const availHeight = 1084;
  
  return `${appCodeName}|${appVersion}|${platform}|${userAgent}|${screenHeight}|${screenWidth}|${colorDepth}|${availWidth}|${availHeight}`;
}

// ============================================================================
// WebForms Postback Discovery
// ============================================================================

export interface PostBackAction {
  /** The __EVENTTARGET value (e.g., "ctl00$MenuPrincipal$lnkConsulta") */
  target: string;
  /** The __EVENTARGUMENT value (often empty) */
  argument: string;
  /** Link/button text associated with this postback */
  text: string;
  /** Priority score for matching transaction-related links (higher = better match) */
  score: number;
}

/**
 * Keywords that indicate a link/button leads to transactions/movements
 * Ordered by priority (higher index = higher priority)
 */
const TRANSACTION_KEYWORDS = [
  'cuenta',
  'estado',
  'consulta',
  'saldo',
  'movimiento',
  'transaccion',
  'historial',
  'ultimos'
];

/**
 * Parse ASP.NET WebForms postback actions from HTML
 * 
 * Looks for patterns like:
 * - javascript:__doPostBack('target','argument')
 * - WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("target", ...))
 * - onclick="__doPostBack(...)"
 * 
 * Returns actions sorted by relevance score (best match first)
 */
export function parsePostBackActions(html: string): PostBackAction[] {
  const actions: PostBackAction[] = [];
  const $ = cheerio.load(html);

  // Pattern 1: href="javascript:__doPostBack('target','arg')"
  const doPostBackRegex = /__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*\)/g;
  
  // Pattern 2: WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("target", ...))
  const postBackOptionsRegex = /WebForm_DoPostBackWithOptions\s*\(\s*new\s+WebForm_PostBackOptions\s*\(\s*["']([^"']+)["']/g;

  // Find all anchor and button elements
  $('a, button, input[type="submit"], input[type="button"]').each((_, element) => {
    const $el = $(element);
    const href = $el.attr('href') || '';
    const onclick = $el.attr('onclick') || '';
    const text = $el.text().trim() || $el.attr('value') || '';
    
    // Check href for __doPostBack
    let match = doPostBackRegex.exec(href);
    doPostBackRegex.lastIndex = 0; // Reset regex state
    
    if (match) {
      const action = createPostBackAction(match[1], match[2], text);
      if (action) actions.push(action);
      return;
    }
    
    // Check onclick for __doPostBack
    match = doPostBackRegex.exec(onclick);
    doPostBackRegex.lastIndex = 0;
    
    if (match) {
      const action = createPostBackAction(match[1], match[2], text);
      if (action) actions.push(action);
      return;
    }
    
    // Check onclick for WebForm_DoPostBackWithOptions
    match = postBackOptionsRegex.exec(onclick);
    postBackOptionsRegex.lastIndex = 0;
    
    if (match) {
      const action = createPostBackAction(match[1], '', text);
      if (action) actions.push(action);
    }
  });

  // Also scan raw HTML for any missed patterns (e.g., inline scripts)
  let rawMatch: RegExpExecArray | null;
  const rawDoPostBackRegex = /href\s*=\s*["']javascript:__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*\)["']/g;
  
  while ((rawMatch = rawDoPostBackRegex.exec(html)) !== null) {
    // Try to find nearby text
    const nearbyText = extractNearbyText(html, rawMatch.index);
    const existing = actions.find(a => a.target === rawMatch![1]);
    if (!existing) {
      const action = createPostBackAction(rawMatch[1], rawMatch[2], nearbyText);
      if (action) actions.push(action);
    }
  }

  // Sort by score descending (best matches first)
  actions.sort((a, b) => b.score - a.score);

  return actions;
}

/**
 * Create a PostBackAction with a relevance score
 */
function createPostBackAction(target: string, argument: string, text: string): PostBackAction | null {
  if (!target) return null;
  
  const score = calculateScore(text, target);
  
  return {
    target,
    argument,
    text,
    score
  };
}

/**
 * Calculate relevance score for a postback action
 */
function calculateScore(text: string, target: string): number {
  const combined = `${text} ${target}`.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // Remove accents
  
  let score = 0;
  
  for (let i = 0; i < TRANSACTION_KEYWORDS.length; i++) {
    if (combined.includes(TRANSACTION_KEYWORDS[i])) {
      score += (i + 1) * 10; // Higher priority keywords get higher scores
    }
  }
  
  // Bonus for text that looks like a menu item (short, capitalized)
  if (text.length > 0 && text.length < 50) {
    score += 5;
  }
  
  return score;
}

/**
 * Extract nearby text from HTML around a given position
 */
function extractNearbyText(html: string, position: number): string {
  // Look for text between > and < around the position
  const searchStart = Math.max(0, position - 200);
  const searchEnd = Math.min(html.length, position + 200);
  const snippet = html.substring(searchStart, searchEnd);
  
  // Find text content patterns
  const textMatch = snippet.match(/>([^<]{2,50})</);
  return textMatch ? textMatch[1].trim() : '';
}

/**
 * Find the best postback action for navigating to transactions
 * Returns null if no suitable action found
 */
export function findBestTransactionPostBack(html: string): PostBackAction | null {
  const actions = parsePostBackActions(html);
  
  // Return the highest-scored action, or null if none found with positive score
  const best = actions.find(a => a.score > 0);
  return best || null;
}

/**
 * Build form data for executing a postback
 */
export function buildPostBackFormData(
  formFields: AspNetFormFields,
  allHiddenFields: Record<string, string>,
  action: PostBackAction
): Record<string, string> {
  return {
    ...formFields,
    ...allHiddenFields,
    __EVENTTARGET: action.target,
    __EVENTARGUMENT: action.argument
  };
}

// ============================================================================
// Account Parsing
// ============================================================================

export interface ParsedAccount {
  type: string;
  accountNumber: string;
  balance: number;
  currency: string;
  postbackTarget?: string;
  postbackArg?: string;
}

/**
 * Parse accounts from the Banesco dashboard HTML
 */
export function parseAccountsFromDashboard(html: string): ParsedAccount[] {
  const $ = cheerio.load(html);
  const accounts: ParsedAccount[] = [];
  
  // Method 1: Look for GridViewHm tables (most reliable for Banesco dashboard)
  $('table.GridViewHm').each((_, table) => {
    const $table = $(table);
    
    $table.find('tr.GridViewHmRow').each((_, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      
      if (cells.length >= 3) {
        const accountType = $(cells[0]).text().trim() || 'Cuenta';
        
        // Find the cell with the account number (contains a link with postback)
        const $accountLink = $row.find('a[href*="__doPostBack"]');
        const accountNumber = $accountLink.text().trim();
        
        // Validate account number format
        if (!accountNumber.match(/^\d{4}-\d{4}-\d{2}-\d+$/)) {
          return; // Skip invalid rows
        }
        
        // Extract postback info
        let postbackTarget = '';
        let postbackArg = '';
        const href = $accountLink.attr('href') || '';
        const postbackMatch = href.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*\)/);
        if (postbackMatch) {
          postbackTarget = postbackMatch[1];
          postbackArg = postbackMatch[2];
        }
        
        // Balance is typically in the 3rd cell (align="right")
        const balanceText = $(cells[2]).text().trim();
        let balance = 0;
        let currency = 'VES';
        
        // Parse balance (format: "983,02" or "1.234,56")
        const balanceMatch = balanceText.match(/([\d.]+),(\d{2})/);
        if (balanceMatch) {
          const wholePart = balanceMatch[1].replace(/\./g, '');
          const decimalPart = balanceMatch[2];
          balance = parseFloat(`${wholePart}.${decimalPart}`);
        }
        
        // Detect currency from account type or parent table
        const parentTableText = $table.closest('div').prev('table').text().toLowerCase();
        if (parentTableText.includes('extranjera') || parentTableText.includes('usd') || accountType.toLowerCase().includes('verde')) {
          currency = 'USD';
        }
        
        // Avoid duplicates
        if (!accounts.find(a => a.accountNumber === accountNumber)) {
          accounts.push({
            type: accountType,
            accountNumber,
            balance,
            currency,
            postbackTarget: postbackTarget || undefined,
            postbackArg: postbackArg || undefined
          });
        }
      }
    });
  });
  
  // Method 2: Fallback - Look for account number pattern in links
  if (accounts.length === 0) {
    $('a').each((_, link) => {
      const $link = $(link);
      const linkText = $link.text().trim();
      const href = $link.attr('href') || '';
      const onclick = $link.attr('onclick') || '';
      
      // Look for account number pattern (####-####-##-##########)
      const accountMatch = linkText.match(/(\d{4}-\d{4}-\d{2}-\d+)/);
      if (accountMatch) {
        const accountNumber = accountMatch[1];
        
        // Avoid duplicates
        if (accounts.find(a => a.accountNumber === accountNumber)) {
          return;
        }
        
        // Try to get context from parent row
        const $row = $link.closest('tr');
        const cells = $row.find('td');
        let accountType = 'Cuenta';
        let balance = 0;
        // Detect currency from the row text (default VES). Previously this was
        // hardcoded to 'VES', mislabelling foreign-currency accounts.
        const currency = /USD|US\$|d[oó]lar/i.test($row.text()) ? 'USD' : 'VES';
        
        // First cell is usually account type
        if (cells.length > 0) {
          const firstCellText = $(cells[0]).text().trim();
          if (firstCellText && !firstCellText.match(/^\d/)) {
            accountType = firstCellText;
          }
        }
        
        // Third cell (or cell with align="right") is usually balance
        const $balanceCell = $row.find('td[align="right"]').first();
        if ($balanceCell.length) {
          const balanceText = $balanceCell.text().trim();
          const balanceMatch = balanceText.match(/([\d.]+),(\d{2})/);
          if (balanceMatch) {
            const wholePart = balanceMatch[1].replace(/\./g, '');
            const decimalPart = balanceMatch[2];
            balance = parseFloat(`${wholePart}.${decimalPart}`);
          }
        }
        
        // Extract postback info
        let postbackTarget = '';
        let postbackArg = '';
        const postbackMatch = (href + ' ' + onclick).match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*\)/);
        if (postbackMatch) {
          postbackTarget = postbackMatch[1];
          postbackArg = postbackMatch[2];
        }
        
        accounts.push({
          type: accountType,
          accountNumber,
          balance,
          currency,
          postbackTarget: postbackTarget || undefined,
          postbackArg: postbackArg || undefined
        });
      }
    });
  }
  
  // Method 3: Scan entire HTML for account patterns if methods 1 and 2 found nothing
  if (accounts.length === 0) {
    // Look for the pattern: account number followed by balance
    const fullText = $('body').text();
    const accountPatterns = fullText.matchAll(/(\d{4}-\d{4}-\d{2}-\d+)\s*([\d.,]+)/g);
    
    for (const match of accountPatterns) {
      const accountNumber = match[1];
      
      // Avoid duplicates
      if (accounts.find(a => a.accountNumber === accountNumber)) {
        continue;
      }
      
      const cleanAmount = match[2]
        .replace(/\./g, '')
        .replace(/,/g, '.');
      const balance = parseFloat(cleanAmount) || 0;
      
      accounts.push({
        type: 'Cuenta',
        accountNumber,
        balance,
        currency: 'VES',
        postbackTarget: undefined,
        postbackArg: undefined
      });
    }
  }
  
  // Method 4: Look in table cells for structured data
  if (accounts.length === 0) {
    $('table').each((_, table) => {
      const $table = $(table);
      
      $table.find('tr').each((_, rowEl) => {
        const $row = $(rowEl);
        const rowText = $row.text();
        
        const accountMatch = rowText.match(/(\d{4}-\d{4}-\d{2}-\d+)/);
        if (accountMatch) {
          const accountNumber = accountMatch[1];
          
          if (accounts.find(a => a.accountNumber === accountNumber)) {
            return;
          }
          
          // Find balance after account number
          const afterAccount = rowText.substring(rowText.indexOf(accountNumber) + accountNumber.length);
          const balanceMatch = afterAccount.match(/([\d.,]+)/);
          let balance = 0;
          if (balanceMatch) {
            const cleanAmount = balanceMatch[1]
              .replace(/\./g, '')
              .replace(/,/g, '.');
            balance = parseFloat(cleanAmount) || 0;
          }
          
          let accountType = 'Cuenta';
          if (rowText.toLowerCase().includes('corriente')) {
            accountType = 'Cuenta Corriente';
          } else if (rowText.toLowerCase().includes('verde')) {
            accountType = 'Cuenta Verde';
          }
          
          accounts.push({
            type: accountType,
            accountNumber,
            balance,
            currency: rowText.includes('$') ? 'USD' : 'VES',
            postbackTarget: undefined,
            postbackArg: undefined
          });
        }
      });
    });
  }
  
  return accounts;
}

/**
 * Parse transaction movements table from account details page
 */
export function parseMovementsTable(html: string): {
  transactions: Array<{
    date: string;
    reference: string;
    description: string;
    debit: number;
    credit: number;
  }>;
  found: boolean;
} {
  const $ = cheerio.load(html);
  const transactions: Array<{
    date: string;
    reference: string;
    description: string;
    debit: number;
    credit: number;
  }> = [];
  
  // Find the movements table - look for tables with date/reference/description headers
  let movementsTable: ReturnType<typeof $> | null = null;
  
  $('table').each((_, table) => {
    const $table = $(table);
    const headerText = $table.find('tr:first-child').text().toLowerCase();
    
    if (
      (headerText.includes('fecha') || headerText.includes('date')) &&
      (headerText.includes('referencia') || headerText.includes('descripción') || headerText.includes('monto'))
    ) {
      movementsTable = $table;
      return false; // break
    }
  });
  
  if (movementsTable === null) {
    return { transactions: [], found: false };
  }
  
  // Parse rows
  (movementsTable as ReturnType<typeof $>).find('tr').slice(1).each((_, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td');
    
    if (cells.length < 3) return;
    
    const rowData: string[] = [];
    cells.each((_, cell) => {
      rowData.push($(cell).text().trim());
    });
    
    // Try to parse the row
    let date = '';
    let reference = '';
    let description = '';
    let debit = 0;
    let credit = 0;
    
    for (const cell of rowData) {
      // Date pattern (DD/MM/YYYY or DD-MM-YYYY)
      if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(cell)) {
        date = cell;
        continue;
      }
      
      // Reference number (usually all digits)
      if (/^\d{6,}$/.test(cell.replace(/\s/g, ''))) {
        reference = cell;
        continue;
      }
      
      // Amount patterns
      const amountMatch = cell.match(/^[\d.,\-\s]+$/);
      if (amountMatch) {
        const cleanAmount = cell
          .replace(/\./g, '')
          .replace(/,/g, '.')
          .replace(/\s/g, '');
        const parsed = parseFloat(cleanAmount);
        if (!isNaN(parsed)) {
          // Assign to debit/credit based on sign
          if (parsed < 0 || cell.includes('-')) {
            debit = Math.abs(parsed);
          } else {
            credit = parsed;
          }
        }
        continue;
      }
      
      // Everything else is likely description
      if (cell.length > description.length && cell.length > 5) {
        description = cell;
      }
    }
    
    if (date || description) {
      transactions.push({
        date,
        reference,
        description,
        debit,
        credit
      });
    }
  });
  
  return { transactions, found: true };
}
