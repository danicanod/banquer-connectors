import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BncTransactionParser } from '../src/banks/bnc/http/transaction-parser.js';

// Locks the stateless BNC transaction parser extracted from BncHttpClient.
const parser = new BncTransactionParser();

const FIXTURE = `
<table id="Tbl_Transactions"><tbody>
  <tr class="cursor-pointer">
    <td>15/07/2026</td><td>Pago</td><td>123456</td><td>-1.234,56</td>
  </tr>
  <tr class="no-padding"><td colspan="4"><div class="font-size-custom">Pago de servicio electrico</div></td></tr>
  <tr class="cursor-pointer">
    <td>16/07/2026</td><td>Abono</td><td>789012</td><td>2.000,00</td>
  </tr>
  <tr class="no-padding"><td colspan="4"><div class="font-size-custom">Deposito de nomina</div></td></tr>
</tbody></table>`;

test('parse: parses rows, dates, amounts and infers debit/credit', () => {
  const txns = parser.parse(FIXTURE, 'VES_ACC');
  assert.equal(txns.length, 2);

  const [debit, credit] = txns;
  assert.equal(debit.date, '2026-07-15');
  assert.equal(debit.amount, 1234.56);
  assert.equal(debit.type, 'debit'); // negative amount
  assert.equal(debit.reference, '123456');
  assert.equal(debit.description, 'Pago de servicio electrico');
  assert.equal(debit.bankName, 'BNC');
  assert.equal(debit.accountName, 'VES_ACC');
  assert.match(debit.id as string, /^bnc-[0-9a-f]{16}$/);

  assert.equal(credit.date, '2026-07-16');
  assert.equal(credit.amount, 2000);
  assert.equal(credit.type, 'credit'); // "Abono" + positive
});

test('parse: same input yields the same deterministic ids (idempotent)', () => {
  const a = parser.parse(FIXTURE, 'VES_ACC');
  const b = parser.parse(FIXTURE, 'VES_ACC');
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
});

test('parse: dash-separated dates are also normalized', () => {
  const html = `<table id="Tbl_Transactions"><tbody>
    <tr class="cursor-pointer"><td>03-01-2026</td><td>Cargo</td><td>111</td><td>-5,00</td></tr>
  </tbody></table>`;
  assert.equal(parser.parse(html)[0].date, '2026-01-03');
});

test('parse: returns [] when the transactions table is absent', () => {
  assert.deepEqual(parser.parse('<div>no table here</div>'), []);
});
