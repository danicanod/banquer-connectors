import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAspNetFormFields,
  parseAllHiddenFields,
  parseMovementsTable,
  parseTransactionsTable,
  parseCookies,
  serializeCookies,
  parseDashboardPage,
} from '../src/banks/banesco/http/form-parser.js';

// These lock the pure HTML parsers that Phase 4 will refactor. Fixtures are
// synthetic but mirror the ASP.NET WebForms structures the code targets.

test('parseAspNetFormFields: extracts VIEWSTATE / generator / event validation', () => {
  const html = `
    <form>
      <input type="hidden" name="__VIEWSTATE" value="VS123" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="GEN456" />
      <input type="hidden" name="__EVENTVALIDATION" value="EV789" />
    </form>`;
  const f = parseAspNetFormFields(html);
  assert.equal(f.__VIEWSTATE, 'VS123');
  assert.equal(f.__VIEWSTATEGENERATOR, 'GEN456');
  assert.equal(f.__EVENTVALIDATION, 'EV789');
});

test('parseAllHiddenFields: collects every hidden input by name', () => {
  const html = `<form>
    <input type="hidden" name="a" value="1" />
    <input type="hidden" name="b" value="" />
    <input type="text" name="visible" value="nope" />
  </form>`;
  const fields = parseAllHiddenFields(html);
  assert.equal(fields.a, '1');
  assert.equal(fields.b, '');
  assert.equal(fields.visible, undefined);
});

test('parseMovementsTable: parses date/reference/description and splits debit vs credit', () => {
  const html = `
    <table>
      <tr><th>Fecha</th><th>Referencia</th><th>Descripción</th><th>Monto</th></tr>
      <tr><td>15/07/2026</td><td>123456</td><td>Pago de servicio electrico</td><td>-1.234,56</td></tr>
      <tr><td>16/07/2026</td><td>789012</td><td>Deposito de nomina mensual</td><td>2.000,00</td></tr>
    </table>`;
  const { transactions, found } = parseMovementsTable(html);
  assert.equal(found, true);
  assert.equal(transactions.length, 2);

  assert.equal(transactions[0].date, '15/07/2026');
  assert.equal(transactions[0].reference, '123456');
  assert.equal(transactions[0].description, 'Pago de servicio electrico');
  assert.equal(transactions[0].debit, 1234.56);
  assert.equal(transactions[0].credit, 0);

  assert.equal(transactions[1].credit, 2000);
  assert.equal(transactions[1].debit, 0);
});

test('parseMovementsTable: reports found=false when no movements table exists', () => {
  const { found, transactions } = parseMovementsTable('<table><tr><th>Nombre</th></tr></table>');
  assert.equal(found, false);
  assert.equal(transactions.length, 0);
});

test('parseTransactionsTable: detects a table by Spanish headers and returns rows', () => {
  const html = `
    <table>
      <tr><th>Fecha</th><th>Monto</th></tr>
      <tr><td>15/07/2026</td><td>100,00</td></tr>
    </table>`;
  const { tableFound, headers, rows } = parseTransactionsTable(html);
  assert.equal(tableFound, true);
  assert.deepEqual(headers, ['Fecha', 'Monto']);
  assert.deepEqual(rows, [['15/07/2026', '100,00']]);
});

test('parseCookies + serializeCookies: round-trip name=value pairs', () => {
  const jar = parseCookies(['SESSIONID=abc123; path=/; HttpOnly', 'CSRF=tok; Secure']);
  assert.equal(jar.get('SESSIONID'), 'abc123');
  assert.equal(jar.get('CSRF'), 'tok');
  assert.equal(serializeCookies(jar), 'SESSIONID=abc123; CSRF=tok');
});

test('parseCookies: null / empty input yields an empty jar', () => {
  assert.equal(parseCookies(null).size, 0);
});

test('parseDashboardPage: a logout link marks the page authenticated', () => {
  const html = `<div><a href="/Website/salir.aspx">Salir</a><a href="/Website/Cuentas.aspx">Cuentas</a></div>`;
  const d = parseDashboardPage(html);
  assert.equal(d.isAuthenticated, true);
  assert.ok(d.menuLinks.some((l) => l.href.includes('Cuentas.aspx')));
  assert.ok(!d.menuLinks.some((l) => l.href.includes('salir')), 'logout link excluded from menu');
});
