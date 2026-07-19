/**
 * Aggregates blocked-request counts during a browser session so the summary can
 * be logged once (on close) instead of spamming a line per aborted request.
 * Extracted from BaseBankAuth.
 */

export type BlockedCategory =
  | 'tracking'
  | 'css'
  | 'image'
  | 'font'
  | 'media'
  | 'nonEssentialJs';

export class BlockedRequestTracker {
  private total = 0;
  private byCategory: Record<BlockedCategory, number> = {
    tracking: 0,
    css: 0,
    image: 0,
    font: 0,
    media: 0,
    nonEssentialJs: 0,
  };
  private summaryLogged = false;

  /** Record one blocked request in the given category. */
  record(category: BlockedCategory): void {
    this.total++;
    this.byCategory[category]++;
  }

  /** Reset all counters (called when a new browser session starts). */
  reset(): void {
    this.total = 0;
    this.byCategory = {
      tracking: 0,
      css: 0,
      image: 0,
      font: 0,
      media: 0,
      nonEssentialJs: 0,
    };
    this.summaryLogged = false;
  }

  /**
   * Return the one-time summary line (e.g. `Blocked resources: 42 (css=10, ...)`),
   * or null if nothing was blocked or the summary was already taken.
   */
  takeSummary(): string | null {
    if (this.summaryLogged || this.total === 0) {
      return null;
    }
    this.summaryLogged = true;

    const { total, byCategory } = this;
    const parts: string[] = [];

    if (byCategory.tracking > 0) parts.push(`tracking=${byCategory.tracking}`);
    if (byCategory.css > 0) parts.push(`css=${byCategory.css}`);
    if (byCategory.image > 0) parts.push(`image=${byCategory.image}`);
    if (byCategory.font > 0) parts.push(`font=${byCategory.font}`);
    if (byCategory.media > 0) parts.push(`media=${byCategory.media}`);
    if (byCategory.nonEssentialJs > 0) parts.push(`js=${byCategory.nonEssentialJs}`);

    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Blocked resources: ${total}${breakdown}`;
  }
}
