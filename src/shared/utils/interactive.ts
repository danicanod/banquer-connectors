/**
 * Interactive Input Utilities
 *
 * Small helpers for reading input from a human during an otherwise-automated
 * flow. Used where a value cannot be known ahead of time and must be supplied
 * live — most importantly one-time 2FA codes (see the Facebank connector).
 *
 * Connectors should prefer an injected async provider (e.g. an `otpProvider`
 * callback) and fall back to these prompts only for interactive/CLI usage.
 * They require a TTY; in a headless/non-interactive process `promptForInput`
 * throws so the caller can surface a clear "supply a provider instead" error.
 */

import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

/**
 * Prompt the user for a line of input on the terminal and resolve with the
 * trimmed answer.
 *
 * @param question - Prompt text shown to the user (e.g. "Enter 2FA code: ").
 * @returns The user's answer with surrounding whitespace trimmed.
 * @throws If stdin is not a TTY (non-interactive process) — supply the value
 *   programmatically instead (e.g. via an `otpProvider` callback in the client
 *   config).
 *
 * @example
 * ```typescript
 * const code = await promptForInput('Enter Facebank 2FA code: ');
 * ```
 */
export async function promptForInput(question: string): Promise<string> {
  if (!input.isTTY) {
    throw new Error(
      'promptForInput requires an interactive terminal (TTY). ' +
        'No TTY detected — supply the value programmatically instead ' +
        '(e.g. an otpProvider callback in the client config).'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
