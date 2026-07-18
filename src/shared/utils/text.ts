/**
 * Small, dependency-free text helpers shared across bank connectors.
 *
 * These centralize logic that was previously copy-pasted across the Banesco and
 * BNC parsers (accent stripping, Venezuelan amount parsing, __doPostBack
 * extraction) plus the error-message narrowing idiom used in every catch block.
 */

/** Remove diacritics: "Descripción" -> "Descripcion". */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Lowercase + strip accents + drop Spanish question/exclamation marks, trimmed.
 * Used to compare free-text question labels against configured keywords.
 */
export function normalizeText(text: string): string {
  return stripAccents(text.toLowerCase())
    .replace(/[¿?¡!]/g, '')
    .trim();
}

/**
 * Parse a Venezuelan-formatted money string into a signed number.
 *
 * Handles the local "1.234,56" convention (dot = thousands, comma = decimal)
 * and the US "1,234.56" convention, deciding by which separator appears last.
 * The sign is preserved so callers can infer debit/credit; returns 0 when the
 * input has no parseable number.
 */
export function parseVesAmount(text: string | null | undefined): number {
  if (!text) return 0;
  let clean = text.replace(/[^\d,.-]/g, '').trim();
  if (!clean || !/\d/.test(clean)) return 0;

  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');

  if (lastComma > lastDot) {
    // Venezuelan: dots are thousands separators, comma is the decimal point.
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else {
    // US-style or single-separator: commas are thousands separators.
    clean = clean.replace(/,/g, '');
  }

  const n = Number.parseFloat(clean);
  return Number.isNaN(n) ? 0 : n;
}

/** Matches `__doPostBack('target','arg')` (single, non-global). */
export const DOPOSTBACK_RE =
  /__doPostBack\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*\)/;

/** Extract the `{target, arg}` from the first `__doPostBack(...)` call in `str`. */
export function extractPostBack(str: string): { target: string; arg: string } | null {
  const m = str.match(DOPOSTBACK_RE);
  return m ? { target: m[1], arg: m[2] ?? '' } : null;
}

/** Narrow an unknown thrown value to a human-readable message. */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
