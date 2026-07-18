/**
 * Dev-only live confirming run for the Facebank connector.
 *
 * Uses credentials from .env and MANUAL OTP mode: a headed browser opens, you
 * type the emailed one-time code directly in that window, and the connector
 * detects the login and proceeds to scrape. Prints login result, accounts, and
 * movements.
 *
 * Run: npx tsx src/dev/facebank-live-run.ts
 * Then, in the browser window, enter the emailed 5-char code and continue.
 */

import 'dotenv/config';
import { createFacebankClient } from '../banks/facebank/index.js';
import { normalizeTransactions } from '../core/index.js';

async function main(): Promise<void> {
  const username = process.env.FACEBANK_USERNAME;
  const password = process.env.FACEBANK_PASSWORD;
  if (!username || !password) {
    console.error('[live-run] Missing FACEBANK_USERNAME/FACEBANK_PASSWORD in .env');
    process.exit(1);
  }

  const client = createFacebankClient(
    { username, password },
    { headless: false, debug: true, manualOtp: true }
  );

  try {
    console.log('[live-run] A browser will open and log in; enter the emailed OTP IN THE BROWSER.');
    const login = await client.login();
    console.log('[live-run] LOGIN:', JSON.stringify(login));
    if (!login.success) return;

    const accounts = await client.getAccounts();
    console.log('[live-run] ACCOUNTS:', JSON.stringify(accounts, null, 2));

    const movements = await client.getAccountMovements();
    console.log(
      `[live-run] MOVEMENTS: success=${movements.success} count=${movements.transactions.length} account=${movements.accountNumber ?? '(none)'} error=${movements.error ?? '(none)'}`
    );
    console.log('[live-run] first 5:', JSON.stringify(movements.transactions.slice(0, 5), null, 2));

    if (movements.transactions.length > 0) {
      const norm = normalizeTransactions('facebank', movements.transactions);
      console.log(`[live-run] NORMALIZED ${norm.length}; sample:`, JSON.stringify(norm[0]));
    }
    console.log('[live-run] DONE');
  } catch (error) {
    console.error('[live-run] ERROR:', error);
  } finally {
    await client.close();
  }
}

main();
