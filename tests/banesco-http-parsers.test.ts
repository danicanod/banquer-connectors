import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeLoginContainer,
  isBanescoErrorPage,
  pageSaysNoMovements,
} from '../src/banks/banesco/http/page-classifier.js';
import {
  parseMovementsFromHtml,
  parseTransactionRowFlexible,
  parseTransactionRows,
  parseAmount,
  parseDate,
} from '../src/banks/banesco/http/movements-parser.js';

// Characterization tests: these LOCK the behavior of the pure HTML/row parsers
// and page classifiers extracted from BanescoHttpClient into standalone modules
// (page-classifier.ts / movements-parser.ts). They are the safety net that made
// splitting the god class safe without live-bank verification — the assertions
// were written against the original private methods and are unchanged here.

// ---------------------------------------------------------------------------
// Page classifiers
// ---------------------------------------------------------------------------

test('looksLikeLoginContainer: login inputs without a logout link => true', () => {
  assert.equal(
    looksLikeLoginContainer('<input name="txtUsuario"> ... login.aspx'),
    true,
  );
});

test('looksLikeLoginContainer: login inputs alongside salir.aspx => false (authenticated)', () => {
  assert.equal(
    looksLikeLoginContainer('<input name="txtUsuario"> ... <a href="salir.aspx">Salir</a>'),
    false,
  );
  assert.equal(looksLikeLoginContainer('login.aspx and the word logout here'), false);
});

test('looksLikeLoginContainer: neither login inputs nor logout => false', () => {
  assert.equal(looksLikeLoginContainer('<div>Cuentas</div>'), false);
});

test('isBanescoErrorPage: matches error.aspx / GUEG001 / the Spanish error text', () => {
  assert.equal(isBanescoErrorPage('redirect to Error.aspx'), true);
  assert.equal(isBanescoErrorPage('code GUEG001 raised'), true);
  assert.equal(
    isBanescoErrorPage('En estos momentos no podemos procesar su operación'),
    true,
  );
  assert.equal(isBanescoErrorPage('<div>Bienvenido</div>'), false);
});

test('pageSaysNoMovements: detects each Spanish "no movements" phrasing', () => {
  for (const phrase of [
    'No posee movimientos',
    'No hay movimientos',
    'No existen movimientos',
    'Sin movimientos',
    'No se encontraron movimientos',
    'No hay registros',
    'Sin registros para mostrar',
  ]) {
    assert.equal(pageSaysNoMovements(`<body>${phrase}</body>`), true, phrase);
  }
  assert.equal(pageSaysNoMovements('<body><table><tr><td>data</td></tr></table></body>'), false);
});

// ---------------------------------------------------------------------------
// parseTransactionRowFlexible (the primary row parser)
// ---------------------------------------------------------------------------

test('parseTransactionRowFlexible: full row with D indicator => debit + reference', () => {
  const tx = parseTransactionRowFlexible([
    '15/07/2026',
    '123456',
    'Pago de servicio electrico',
    '1.234,56',
    'D',
  ]);
  assert.deepEqual(tx, {
    date: '2026-07-15',
    description: 'Pago de servicio electrico',
    amount: 1234.56,
    type: 'debit',
    reference: '123456',
  });
});

test('parseTransactionRowFlexible: no D/C cell defaults to credit, no reference', () => {
  const tx = parseTransactionRowFlexible(['16/07/2026', 'Deposito nomina', '2.000,00']);
  assert.deepEqual(tx, {
    date: '2026-07-16',
    description: 'Deposito nomina',
    amount: 2000,
    type: 'credit',
    reference: undefined,
  });
});

test('parseTransactionRowFlexible: negative amount forces debit', () => {
  const tx = parseTransactionRowFlexible(['10/01/2025', 'Compra', '-50,00']);
  assert.equal(tx.type, 'debit');
  assert.equal(tx.amount, 50);
});

test('parseTransactionRowFlexible: two-digit year is expanded to 20xx', () => {
  const tx = parseTransactionRowFlexible(['05/03/25', 'Cargo', '10,00']);
  assert.equal(tx.date, '2025-03-05');
});

test('parseTransactionRowFlexible: returns null without a date or with zero amount', () => {
  assert.equal(parseTransactionRowFlexible(['no date', '1.234,56']), null);
  assert.equal(parseTransactionRowFlexible(['15/07/2026', 'solo texto']), null);
});

// ---------------------------------------------------------------------------
// parseMovementsFromHtml (table extraction wrapper)
// ---------------------------------------------------------------------------

test('parseMovementsFromHtml: extracts rows from a table with transaction headers', () => {
  const html = `
    <table>
      <tr><th>Fecha</th><th>Referencia</th><th>Descripción</th><th>Monto</th><th>D/C</th></tr>
      <tr><td>15/07/2026</td><td>123456</td><td>Pago de servicio electrico</td><td>1.234,56</td><td>D</td></tr>
      <tr><td>16/07/2026</td><td>789012</td><td>Deposito de nomina mensual</td><td>2.000,00</td><td>C</td></tr>
    </table>`;
  const txns = parseMovementsFromHtml(html, '0134');
  assert.equal(txns.length, 2);
  assert.equal(txns[0].type, 'debit');
  assert.equal(txns[0].amount, 1234.56);
  assert.equal(txns[1].type, 'credit');
  assert.equal(txns[1].amount, 2000);
});

test('parseMovementsFromHtml: a "no movements" page yields an empty list', () => {
  assert.deepEqual(
    parseMovementsFromHtml('<body>No posee movimientos</body>', '0134'),
    [],
  );
});

test('parseMovementsFromHtml: a table without transaction headers is ignored', () => {
  const html = '<table><tr><th>Nombre</th></tr><tr><td>Juan</td></tr></table>';
  assert.deepEqual(parseMovementsFromHtml(html, '0134'), []);
});

// ---------------------------------------------------------------------------
// Legacy parser family (parseTransactionRows + helpers)
// ---------------------------------------------------------------------------

test('parseTransactionRows: legacy path parses date/amount/description/DC (no reference field)', () => {
  const txns = parseTransactionRows([
    ['15/07/2026', 'Pago electrico', '1.234,56', 'D'],
    ['16/07/2026', 'Deposito nomina', '2.000,00', 'C'],
  ]);
  assert.equal(txns.length, 2);
  assert.deepEqual(txns[0], {
    date: '2026-07-15',
    description: 'Pago electrico',
    amount: 1234.56,
    type: 'debit',
  });
  assert.equal(txns[1].type, 'credit');
});

test('parseTransactionRows: rows shorter than 3 cells, or missing date/amount, are skipped', () => {
  assert.deepEqual(parseTransactionRows([['15/07/2026', '1.234,56']]), []);
  assert.deepEqual(parseTransactionRows([['no date', 'desc', 'more']]), []);
});

test('parseAmount: Venezuelan format (dot thousands, comma decimal), strips symbols', () => {
  assert.equal(parseAmount('Bs. 1.234,56'), 1234.56);
  assert.equal(parseAmount('2.000,00'), 2000);
  assert.equal(parseAmount('sin numero'), 0);
});

test('parseDate: DD/MM/YYYY and DD-MM-YYYY both normalize to ISO', () => {
  assert.equal(parseDate('15/07/2026'), '2026-07-15');
  assert.equal(parseDate('15-07-2026'), '2026-07-15');
});
