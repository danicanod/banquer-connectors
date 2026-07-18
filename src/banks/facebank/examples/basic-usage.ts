/**
 * Facebank Basic Usage Example
 *
 * Demonstrates the FacebankClient:
 * - Login (Playwright; emails a 5-char OTP)
 * - Listing accounts (in-browser)
 * - Reading movements (in-browser) + normalizing to the unified Transaction model
 *
 * Run with: npm run example:facebank
 * Or:       tsx src/banks/facebank/examples/basic-usage.ts
 *
 * Environment variables:
 * - FACEBANK_USERNAME  (required)
 * - FACEBANK_PASSWORD  (required)
 * - FACEBANK_SECRET_WORD  (optional; alias for the security-image step-up)
 * - FACEBANK_SECRET_IMAGE (optional; registered image id for the step-up)
 * - FACEBANK_DEBUG=true   (optional; verbose logging)
 *
 * The one-time code is emailed at login. This example lets the client prompt for
 * it on the terminal; alternatively pass an `otpProvider` in the config to
 * supply it programmatically.
 */

import { config } from 'dotenv';
config();

import { createFacebankClient } from '../index.js';
import { normalizeTransactions } from '../../../core/index.js';

function getCredentials() {
  const username = process.env.FACEBANK_USERNAME;
  const password = process.env.FACEBANK_PASSWORD;

  if (!username || !password) {
    console.error('❌ Missing credentials. Set these environment variables:');
    console.error('   FACEBANK_USERNAME: Your Facebank username');
    console.error('   FACEBANK_PASSWORD: Your Facebank password');
    process.exit(1);
  }

  return {
    username,
    password,
    // Only used if the (rare) security-image step-up screen appears.
    secretWord: process.env.FACEBANK_SECRET_WORD || process.env.FACEBANK_SECURITY_QUESTION,
    secretImage: process.env.FACEBANK_SECRET_IMAGE,
  };
}

async function main() {
  console.log('🏦 Facebank Basic Usage Example');
  console.log('================================\n');

  const credentials = getCredentials();
  const debug = process.env.FACEBANK_DEBUG === 'true';

  // Headed so you can watch the flow; the emailed OTP is requested on the
  // terminal unless you provide an otpProvider callback here.
  const client = createFacebankClient(credentials, {
    headless: false,
    debug,
    // otpProvider: async () => fetchCodeFromYourInbox(),
  });

  const startTime = Date.now();

  try {
    console.log('🔐 Logging in (Playwright; a one-time code will be emailed to you)...');
    const loginResult = await client.login();

    if (!loginResult.success) {
      console.log(`❌ Login failed: ${loginResult.message}`);
      return;
    }
    console.log(`✅ Login successful${loginResult.imageChallengeSeen ? ' (image step-up handled)' : ''}`);

    // Accounts
    console.log('\n📋 Fetching accounts...');
    const accountsResult = await client.getAccounts();
    if (accountsResult.success && accountsResult.accounts.length > 0) {
      console.log(`✅ Found ${accountsResult.accounts.length} account(s):`);
      for (const account of accountsResult.accounts) {
        console.log(
          `   - ${account.accountType || 'Cuenta'}: ${account.accountNumber} ` +
            `(${account.currency} ${account.balance.toLocaleString()})`
        );
      }
    } else {
      console.log(`⚠️  No accounts found${accountsResult.error ? ` (${accountsResult.error})` : ''}`);
    }

    // Movements
    console.log('\n📊 Fetching movements...');
    const movementsResult = await client.getAccountMovements();
    if (movementsResult.success && movementsResult.transactions.length > 0) {
      console.log(
        `✅ Found ${movementsResult.transactions.length} movement(s)` +
          `${movementsResult.accountNumber ? ` for account ${movementsResult.accountNumber}` : ''}:`
      );
      movementsResult.transactions.slice(0, 5).forEach((tx, i) => {
        const icon = tx.type === 'credit' ? '📥' : '📤';
        console.log(
          `   ${i + 1}. ${tx.date} ${icon} ${String(tx.amount).padStart(12)} | ${tx.description.substring(0, 40)}`
        );
      });
      if (movementsResult.transactions.length > 5) {
        console.log(`   ... and ${movementsResult.transactions.length - 5} more`);
      }

      // Normalize to the unified, bank-agnostic Transaction model
      const normalized = normalizeTransactions('facebank', movementsResult.transactions);
      console.log(`\n🔗 Normalized ${normalized.length} transaction(s). Sample:`);
      console.log(JSON.stringify(normalized[0], null, 2));
    } else {
      console.log(`⚠️  No movements found${movementsResult.error ? ` (${movementsResult.error})` : ''}`);
    }

    console.log(`\n⏱️  Total time: ${Date.now() - startTime}ms`);
    console.log('✅ Example completed!');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n Error: ${message}`);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
