/**
 * File-backed debug logger extracted from BaseBankAuth.
 *
 * When enabled (the consumer opted into `debug`), messages go to stdout AND are
 * appended to a per-session log file. When disabled it is completely silent —
 * important for a published library, so a normal login never writes a stray
 * `debug-<bank>-<user>-<ts>.log` into the consumer's working directory.
 */

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';

export class DebugFileLogger {
  constructor(
    private readonly logFile: string,
    private readonly enabled: boolean,
  ) {}

  /** Log a diagnostic message. Silent unless debug is enabled. */
  log(message: string): void {
    if (!this.enabled) return;

    console.log(message);

    const logEntry = `[${new Date().toISOString()}] ${message}`;
    try {
      appendFileSync(this.logFile, logEntry + '\n');
    } catch (error) {
      // Fallback if file writing fails
      console.warn('Failed to write to log file:', error);
    }
  }

  /** Path of the session log file. */
  getLogFile(): string {
    return this.logFile;
  }

  /** Read the log file's current contents (or a placeholder message). */
  getLogContent(): string {
    try {
      if (existsSync(this.logFile)) {
        return readFileSync(this.logFile, 'utf-8');
      }
      return 'Log file not found';
    } catch (error) {
      return `Error reading log file: ${error}`;
    }
  }

  /** Copy the current log contents to another path. Returns success. */
  exportLogs(targetPath: string): boolean {
    try {
      const content = this.getLogContent();
      writeFileSync(targetPath, content);
      this.log(`Logs exported to: ${targetPath}`);
      return true;
    } catch (error) {
      this.log(`Failed to export logs: ${error}`);
      return false;
    }
  }
}
