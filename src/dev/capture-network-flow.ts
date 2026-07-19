/**
 * Network Flow Capture Script
 * 
 * Runs the bank authentication flow while capturing all HTTP requests
 * for analysis. Use this to understand the exact flow needed for a
 * pure fetch-based implementation.
 * 
 * Usage:
 *   1. Set credentials in .env file
 *   2. Run: npx tsx src/shared/examples/capture-network-flow.ts
 *   3. Review console output and generated JSON file
 */

import 'dotenv/config';
import { chromium, Browser, Page, BrowserContext, ElementHandle } from 'playwright';
import { NetworkLogger } from './network-logger.js';

// ============================================================================
// Configuration
// ============================================================================

interface CaptureConfig {
  bank: 'banesco' | 'bnc';
  headless: boolean;
  slowMo: number;  // Slow down for visibility
  timeout: number;
}

const config: CaptureConfig = {
  bank: (process.env.CAPTURE_BANK as 'banesco' | 'bnc') || 'banesco',
  headless: process.env.HEADLESS === 'true',
  slowMo: 500,  // 500ms between actions for visibility
  timeout: 30000
};

// ============================================================================
// Banesco Flow
// ============================================================================

async function captureBanescoFlow(page: Page, _networkLogger: NetworkLogger): Promise<void> {
  const username = process.env.BANESCO_USERNAME;
  const password = process.env.BANESCO_PASSWORD;
  const securityQuestions = process.env.BANESCO_SECURITY_QUESTIONS;

  if (!username || !password) {
    throw new Error('Missing BANESCO_USERNAME or BANESCO_PASSWORD in .env');
  }

  console.log('\n🏦 Starting Banesco login flow capture...\n');
  console.log(`   Username: ${username.substring(0, 3)}***`);
  console.log(`   Security Questions: ${securityQuestions ? 'configured' : 'not configured'}\n`);

  // Step 1: Navigate to login page
  console.log('📍 Step 1: Navigate to login page');
  await page.goto('https://www.banesconline.com/mantis/Website/Login.aspx', {
    waitUntil: 'domcontentloaded',
    timeout: config.timeout
  });

  // Wait for iframe to load
  await page.waitForSelector('iframe#ctl00_cp_frmAplicacion', { timeout: config.timeout });
  const iframeElement = await page.$('iframe#ctl00_cp_frmAplicacion');
  const frame = await iframeElement?.contentFrame();

  if (!frame) {
    throw new Error('Could not access login iframe');
  }

  await frame.waitForLoadState('domcontentloaded');
  console.log('   ✅ Login iframe loaded\n');

  // Step 2: Enter username
  console.log('📍 Step 2: Enter username and submit');
  await frame.waitForSelector('#ctl00_cp_ddpControles_txtloginname', { timeout: config.timeout });
  await frame.fill('#ctl00_cp_ddpControles_txtloginname', username);
  await page.waitForTimeout(500);

  // Click Aceptar
  await frame.click('#ctl00_cp_ddpControles_btnAcceder');
  console.log('   ✅ Username submitted\n');

  // Wait for next step (security questions or password)
  await page.waitForTimeout(3000);

  // Step 3: Handle security questions if present
  console.log('📍 Step 3: Check for security questions');
  
  // Re-get iframe after navigation
  const iframe2 = await page.$('iframe#ctl00_cp_frmAplicacion');
  const frame2 = await iframe2?.contentFrame();

  if (frame2) {
    await frame2.waitForLoadState('domcontentloaded');
    
    // Check for security question fields
    const securityField = await frame2.$('#ctl00_cp_ddpControles_txtpreguntasecreta');
    
    if (securityField && securityQuestions) {
      console.log('   🔒 Security questions detected, handling...');
      
      // Parse security questions from env
      const questionMap = parseSecurityQuestions(securityQuestions);
      
      // Find and answer questions
      const questionElements = [
        { labelId: 'lblPrimeraP', inputId: 'txtPrimeraR' },
        { labelId: 'lblSegundaP', inputId: 'txtSegundaR' },
        { labelId: 'lblTerceraP', inputId: 'txtTerceraR' },
        { labelId: 'lblCuartaP', inputId: 'txtCuartaR' }
      ];

      for (const element of questionElements) {
        try {
          const labelElement = await frame2.$(`#${element.labelId}`);
          if (!labelElement) continue;

          const questionText = await labelElement.textContent();
          if (!questionText) continue;

          const answer = findMatchingAnswer(questionText, questionMap);
          if (answer) {
            const inputElement = await frame2.$(`#${element.inputId}`);
            if (inputElement && await inputElement.isVisible()) {
              await inputElement.fill(answer);
              console.log(`      Answered: ${questionText.substring(0, 30)}...`);
            }
          }
        } catch {
          continue;
        }
      }
      console.log('   ✅ Security questions handled\n');
    } else {
      console.log('   ℹ️  No security questions detected\n');
    }

    // Step 4: Enter password
    console.log('📍 Step 4: Enter password and submit');
    
    const passwordField = await frame2.$('#ctl00_cp_ddpControles_txtclave');
    if (passwordField) {
      await frame2.fill('#ctl00_cp_ddpControles_txtclave', '');
      await frame2.type('#ctl00_cp_ddpControles_txtclave', password, { delay: 50 });
      await page.waitForTimeout(500);

      // Submit
      await frame2.click('#ctl00_cp_ddpControles_btnAcceder');
      console.log('   ✅ Password submitted\n');
    }
  }

  // Step 5: Wait for dashboard/authenticated page
  console.log('📍 Step 5: Waiting for authenticated page...');
  await page.waitForTimeout(5000);

  const finalUrl = page.url();
  console.log(`   📍 Final URL: ${finalUrl}\n`);

  // Check if we're authenticated
  const isAuthenticated = !finalUrl.includes('Login.aspx') && 
                          (finalUrl.includes('default.aspx') || finalUrl.includes('Default.aspx'));

  if (isAuthenticated) {
    console.log('   ✅ Authentication appears successful!\n');
    
    // Try to navigate to transactions page
    console.log('📍 Step 6: Looking for transaction/account links...');
    await page.waitForTimeout(2000);
    
    // Save the current state
    const pageContent = await page.content();
    const hasMenuLinks = pageContent.includes('Consulta') || 
                         pageContent.includes('Movimientos') ||
                         pageContent.includes('Cuentas');
    
    if (hasMenuLinks) {
      console.log('   ✅ Menu/navigation links detected\n');
    }
    
    // Step 7: Attempt auto-navigation to transactions/movements
    console.log('📍 Step 7: Attempting auto-navigation to transactions view...');
    await attemptTransactionNavigation(page);
    
  } else {
    console.log('   ⚠️  May still be on login page or intermediate step\n');
  }
}

/**
 * Attempt to navigate to transactions/movements view by clicking likely links
 * This is best-effort and non-fatal if it fails
 */
async function attemptTransactionNavigation(page: Page): Promise<void> {
  const transactionKeywords = [
    'movimientos',
    'consulta',
    'transacciones',
    'estado de cuenta',
    'ultimos movimientos',
    'historial',
    'cuentas'
  ];
  
  try {
    // Find all clickable elements with transaction-related text
    const links = await page.$$('a, button, [onclick]');
    
    let bestLink: { element: ElementHandle<SVGElement | HTMLElement>; text: string; score: number } | null = null;
    
    for (const link of links) {
      try {
        const text = (await link.textContent())?.toLowerCase().trim() || '';
        const href = await link.getAttribute('href') || '';
        const onclick = await link.getAttribute('onclick') || '';
        
        // Calculate match score
        let score = 0;
        for (let i = 0; i < transactionKeywords.length; i++) {
          const keyword = transactionKeywords[i];
          if (text.includes(keyword) || href.includes(keyword) || onclick.includes(keyword)) {
            score += (transactionKeywords.length - i) * 10; // Higher score for earlier keywords
          }
        }
        
        // Skip navigation/logout links
        if (text.includes('salir') || text.includes('cerrar') || href.includes('logout')) {
          continue;
        }
        
        if (score > 0 && (!bestLink || score > bestLink.score)) {
          bestLink = { element: link, text: text.substring(0, 50), score };
        }
      } catch {
        continue;
      }
    }
    
    if (bestLink) {
      console.log(`   🔗 Found best match: "${bestLink.text}" (score: ${bestLink.score})`);
      console.log('   🖱️  Clicking to navigate...');
      
      try {
        // Click and wait for navigation or content change
        await Promise.race([
          bestLink.element.click(),
          page.waitForTimeout(1000)
        ]);
        
        // Wait for potential page load
        await page.waitForTimeout(3000);
        
        const newUrl = page.url();
        console.log(`   📍 After click URL: ${newUrl}`);
        
        // Check if we got a transactions table
        const content = await page.content();
        const hasTransactionTable = 
          (content.includes('Fecha') && content.includes('Monto')) ||
          (content.includes('fecha') && content.includes('descripci')) ||
          content.includes('Movimientos') ||
          content.includes('Saldo');
        
        if (hasTransactionTable) {
          console.log('   ✅ Transaction/account data detected!\n');
        } else {
          console.log('   ⚠️  Page loaded but transaction table not found\n');
          
          // Try one more click if there are nested navigation elements
          await attemptSecondLevelNavigation(page);
        }
      } catch (clickError) {
        console.log(`   ⚠️  Click failed: ${clickError}\n`);
      }
    } else {
      console.log('   ⚠️  No transaction-related links found\n');
    }
    
  } catch (error) {
    console.log(`   ⚠️  Auto-navigation failed (non-fatal): ${error}\n`);
  }
}

/**
 * Try a second level of navigation (e.g., after selecting an account category)
 */
async function attemptSecondLevelNavigation(page: Page): Promise<void> {
  try {
    console.log('   🔄 Trying second-level navigation...');
    
    // Look for account selection or "ver movimientos" type links
    const secondaryKeywords = ['ver', 'detalle', 'consultar', 'seleccionar'];
    
    const links = await page.$$('a, button, [onclick]');
    
    for (const link of links) {
      try {
        const text = (await link.textContent())?.toLowerCase().trim() || '';
        
        const matches = secondaryKeywords.some(kw => text.includes(kw));
        if (matches && !text.includes('salir')) {
          console.log(`   🔗 Found secondary link: "${text.substring(0, 40)}"`);
          
          await Promise.race([
            link.click(),
            page.waitForTimeout(1000)
          ]);
          
          await page.waitForTimeout(3000);
          console.log(`   📍 After second click URL: ${page.url()}`);
          
          const content = await page.content();
          const hasData = content.includes('Fecha') || content.includes('Monto') || content.includes('Saldo');
          
          if (hasData) {
            console.log('   ✅ Data found after second navigation!\n');
          }
          
          break; // Only try one secondary click
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.log(`   ⚠️  Second-level navigation failed: ${error}\n`);
  }
}

// ============================================================================
// BNC Flow
// ============================================================================

async function captureBncFlow(page: Page, _networkLogger: NetworkLogger): Promise<void> {
  const cardNumber = process.env.BNC_CARD;
  const userId = process.env.BNC_ID;
  const password = process.env.BNC_PASSWORD;

  if (!cardNumber || !userId || !password) {
    throw new Error('Missing BNC_CARD, BNC_ID, or BNC_PASSWORD in .env');
  }

  console.log('\n🏦 Starting BNC login flow capture...\n');
  console.log(`   Card: ${cardNumber.substring(0, 4)}****`);
  console.log(`   User ID: ${userId.substring(0, 3)}***\n`);

  // Step 1: Navigate to login page
  console.log('📍 Step 1: Navigate to login page');
  await page.goto('https://personas.bncenlinea.com/', {
    waitUntil: 'domcontentloaded',
    timeout: config.timeout
  });
  console.log('   ✅ Login page loaded\n');

  // Step 2: Enter card and user ID
  console.log('📍 Step 2: Enter card number and user ID');
  await page.waitForSelector('#CardNumber', { timeout: config.timeout });
  await page.fill('#CardNumber', cardNumber);
  await page.fill('#UserID', userId);
  await page.waitForTimeout(500);

  // Submit first step
  await page.click('button#BtnSend');
  console.log('   ✅ Initial credentials submitted\n');

  // Step 3: Wait for password field
  console.log('📍 Step 3: Waiting for password field...');
  await page.waitForSelector('#UserPassword', { timeout: 20000 });
  console.log('   ✅ Password field appeared\n');

  // Step 4: Enter password
  console.log('📍 Step 4: Enter password and submit');
  await page.fill('#UserPassword', '');
  await page.type('#UserPassword', password, { delay: 50 });
  await page.waitForTimeout(500);

  await page.click('button#BtnSend');
  console.log('   ✅ Password submitted\n');

  // Step 5: Wait for authenticated page
  console.log('📍 Step 5: Waiting for authenticated page...');
  await page.waitForTimeout(3000);

  const finalUrl = page.url();
  console.log(`   📍 Final URL: ${finalUrl}\n`);

  // Check if authenticated
  const isAuthenticated = finalUrl.includes('Welcome') || 
                          finalUrl.includes('Home') ||
                          finalUrl.includes('dashboard');

  if (isAuthenticated) {
    console.log('   ✅ Authentication successful!\n');
    
    // Step 6: Navigate to transactions page
    console.log('📍 Step 6: Navigate to transactions page');
    await page.goto('https://personas.bncenlinea.com/Accounts/Transactions/Last25', {
      waitUntil: 'networkidle',
      timeout: config.timeout
    });
    
    // Wait for JavaScript to render the UI
    console.log('   ⏳ Waiting for page JavaScript to render...');
    await page.waitForTimeout(3000);
    console.log('   ✅ Transactions page loaded\n');
    
    // Step 7: Find and click the filter/dropdown button (using the exact BNC selector pattern)
    console.log('📍 Step 7: Click filter button');
    
    // BNC uses Bootstrap-Select which creates a custom dropdown button
    // The selector from types: '#PnlFilter > div.card.container-card.rounded > div.card-body > div > div.col-12.col-md-8.pb-4.pb-md-2 > div.form-label-floating > div > button'
    const filterButtonSelector = 'button.dropdown-toggle.btn-outline-primary, .bootstrap-select button.dropdown-toggle';
    const filterButton = page.locator(filterButtonSelector);
    
    if (await filterButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
      await filterButton.first().click();
      await page.waitForTimeout(1000);
      console.log('   ✅ Filter dropdown opened\n');
      
      // Step 8: Select first account from the bootstrap-select dropdown
      console.log('📍 Step 8: Select account from dropdown');
      
      // Bootstrap-select creates list items like #bs-select-1-1, #bs-select-1-2, etc.
      const accountOption = page.locator('#bs-select-1-1, .dropdown-menu.inner li:nth-child(2) a');
      if (await accountOption.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await accountOption.first().click();
        await page.waitForTimeout(500);
        console.log('   ✅ Account selected\n');
      } else {
        console.log('   ⚠️  Account options not visible\n');
      }
    } else {
      console.log('   ⚠️  Filter button not visible, checking page content...\n');
      
      // Debug: print what's on the page
      const content = await page.content();
      console.log(`   Page has 'bootstrap-select': ${content.includes('bootstrap-select')}`);
      console.log(`   Page has 'dropdown-toggle': ${content.includes('dropdown-toggle')}`);
      console.log(`   Page has 'ddlAccounts': ${content.includes('ddlAccounts')}`);
    }
    
    // Step 9: Click search button to trigger AJAX
    console.log('📍 Step 9: Click search button to load transactions');
    
    // BNC search button selector from types
    const searchButtonSelector = 'button.btn-primary:has-text("Buscar"), #btnSearch, button[type="submit"]:has-text("Buscar")';
    const searchButton = page.locator(searchButtonSelector);
    
    if (await searchButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log('   🔍 Found search button, clicking...');
      await searchButton.first().click();
      console.log('   🔄 Search button clicked, waiting for AJAX response...\n');
      
      // Wait for table to populate
      await page.waitForTimeout(5000);
      
      // Check for transaction table
      const transactionTable = page.locator('#Tbl_Transactions');
      if (await transactionTable.isVisible({ timeout: 5000 }).catch(() => false)) {
        const rows = await transactionTable.locator('tbody tr').count();
        console.log(`   ✅ Transaction table found with ${rows} rows\n`);
      } else {
        console.log('   ⚠️  Transaction table not visible after search\n');
      }
    } else {
      console.log('   ⚠️  Search button not visible\n');
      
      // Fallback: List all buttons on the page
      const allButtons = await page.locator('button').all();
      console.log(`   Found ${allButtons.length} buttons on page:`);
      for (let i = 0; i < Math.min(allButtons.length, 5); i++) {
        const text = await allButtons[i].textContent().catch(() => '(no text)');
        console.log(`      - Button ${i + 1}: "${text?.trim().substring(0, 40)}"`);
      }
    }
    
    // Step 10: Log final page state
    console.log('\n📍 Step 10: Final page analysis');
    const pageContent = await page.content();
    console.log(`   Page has Tbl_Transactions: ${pageContent.includes('Tbl_Transactions')}`);
    console.log(`   Page has ddlAccounts: ${pageContent.includes('ddlAccounts')}`);
    console.log(`   Page has bootstrap-select: ${pageContent.includes('bootstrap-select')}`);
    console.log(`   Page has transaction data: ${pageContent.includes('Fecha') && pageContent.includes('Monto')}\n`);
    
  } else {
    console.log('   ⚠️  May still be on login or intermediate step\n');
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseSecurityQuestions(config: string): Map<string, string> {
  const map = new Map<string, string>();
  const pairs = config.split(',');
  
  for (const pair of pairs) {
    const [keyword, answer] = pair.split(':');
    if (keyword && answer) {
      const normalizedKeyword = keyword.trim().toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      map.set(normalizedKeyword, answer.trim());
    }
  }
  
  return map;
}

function findMatchingAnswer(questionText: string, questionMap: Map<string, string>): string | null {
  const normalizedQuestion = questionText.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!]/g, '');

  for (const [keyword, answer] of questionMap.entries()) {
    if (normalizedQuestion.includes(keyword)) {
      return answer;
    }
  }
  
  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('═'.repeat(80));
  console.log('🔍 NETWORK FLOW CAPTURE');
  console.log(`   Bank: ${config.bank.toUpperCase()}`);
  console.log(`   Headless: ${config.headless}`);
  console.log('═'.repeat(80));

  let browser: Browser | null = null;

  try {
    // Launch browser
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'es-VE',
      timezoneId: 'America/Caracas'
    });

    const page: Page = await context.newPage();

    // Create and attach network logger
    const networkLogger = new NetworkLogger({
      logToConsole: true,
      saveToFile: true,
      outputPath: `network-capture-${config.bank}-${Date.now()}.json`,
      filterEssentialOnly: true,
      redactSensitive: true
    });
    networkLogger.attach(page);

    // Run the appropriate flow
    if (config.bank === 'banesco') {
      await captureBanescoFlow(page, networkLogger);
    } else {
      await captureBncFlow(page, networkLogger);
    }

    // Save network capture
    console.log('\n' + '═'.repeat(80));
    networkLogger.save();
    console.log('═'.repeat(80));

    // Keep browser open for a moment to see final state
    console.log('\n⏳ Keeping browser open for 10 seconds to inspect final state...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('\n💥 Error during capture:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('\n🧹 Browser closed');
    }
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
