/**
 * Pure Banesco page classifiers (extracted from BanescoHttpClient).
 *
 * Each takes a raw HTML string and returns a boolean — no network, no state —
 * so they are unit-testable in isolation (see tests/banesco-http-parsers.test.ts).
 */

import * as cheerio from 'cheerio';

/** True when the HTML looks like the UNAUTHENTICATED login container. */
export function looksLikeLoginContainer(html: string): boolean {
  const lower = html.toLowerCase();
  // Authenticated container still contains salir.aspx; unauthenticated login has txtUsuario
  const hasSalir = lower.includes('salir.aspx') || lower.includes('logout');
  const hasLoginInputs = lower.includes('txtusuario') || lower.includes('txtloginname') || lower.includes('login.aspx');
  // If it has login inputs without salir, it's likely not authenticated.
  return hasLoginInputs && !hasSalir;
}

/** True when the HTML is a Banesco error page (error.aspx / GUEG001 / outage text). */
export function isBanescoErrorPage(html: string): boolean {
  const lower = html.toLowerCase();
  return lower.includes('error.aspx') || lower.includes('en estos momentos no podemos procesar su operación') || lower.includes('gueg001');
}

/** True when the page explicitly states there are no movements to show. */
export function pageSaysNoMovements(html: string): boolean {
  const pageText = cheerio.load(html)('body').text().toLowerCase();
  return (
    pageText.includes('no posee movimientos') ||
    pageText.includes('no hay movimientos') ||
    pageText.includes('no existen movimientos') ||
    pageText.includes('sin movimientos') ||
    pageText.includes('no se encontraron movimientos') ||
    pageText.includes('no hay registros') ||
    pageText.includes('sin registros para mostrar')
  );
}
