import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTxnKey,
  normalizeTransaction,
  normalizeTransactions,
} from '../src/core/transactions.js';

// ---------------------------------------------------------------------------
// makeTxnKey — the deterministic idempotency contract. A regression here would
// silently corrupt de-duplication in downstream storage, so it is locked hard.
// ---------------------------------------------------------------------------

test('makeTxnKey: format is `{bank}-{16 hex}`', () => {
  const key = makeTxnKey('banesco', {
    date: '2026-07-18',
    amount: -1500.5,
    description: 'ATM Withdrawal',
    type: 'debit',
  });
  assert.match(key, /^banesco-[0-9a-f]{16}$/);
});

test('makeTxnKey: deterministic and sign-independent (uses abs amount)', () => {
  const neg = makeTxnKey('bnc', { date: '2026-07-18', amount: -10, description: 'x', type: 'debit' });
  const pos = makeTxnKey('bnc', { date: '2026-07-18', amount: 10, description: 'x', type: 'debit' });
  assert.equal(neg, pos);
});

test('makeTxnKey: reference is preferred over description as the identifier', () => {
  const withRef = makeTxnKey('bnc', { date: '2026-07-18', amount: 10, description: 'desc-A', type: 'credit', reference: 'REF1' });
  const otherDescSameRef = makeTxnKey('bnc', { date: '2026-07-18', amount: 10, description: 'desc-B', type: 'credit', reference: 'REF1' });
  const noRef = makeTxnKey('bnc', { date: '2026-07-18', amount: 10, description: 'desc-A', type: 'credit' });
  assert.equal(withRef, otherDescSameRef, 'description must not affect the key when reference is present');
  assert.notEqual(withRef, noRef, 'reference vs description-only must differ');
});

test('makeTxnKey: different banks namespace the same txn differently', () => {
  const a = makeTxnKey('banesco', { date: '2026-07-18', amount: 10, description: 'x', type: 'credit' });
  const b = makeTxnKey('bnc', { date: '2026-07-18', amount: 10, description: 'x', type: 'credit' });
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// normalizeTransaction
// ---------------------------------------------------------------------------

test('normalizeTransaction: amount is made positive and core fields mapped', () => {
  const n = normalizeTransaction('banesco', {
    date: '2026-07-18',
    amount: -1234.56,
    description: 'Pago',
    type: 'debit',
  });
  assert.equal(n.bank, 'banesco');
  assert.equal(n.amount, 1234.56);
  assert.equal(n.date, '2026-07-18');
  assert.equal(n.type, 'debit');
  assert.match(n.txnKey, /^banesco-[0-9a-f]{16}$/);
});

test('normalizeTransaction: existing string id is used verbatim as txnKey', () => {
  const n = normalizeTransaction('bnc', { id: 'bnc-preset123', date: '2026-07-18', amount: 5, description: 'x', type: 'credit' });
  assert.equal(n.txnKey, 'bnc-preset123');
});

test('normalizeTransaction: referenceNumber wins over reference', () => {
  const n = normalizeTransaction('bnc', {
    date: '2026-07-18', amount: 5, description: 'x', type: 'credit',
    reference: 'R2', referenceNumber: 'R1',
  });
  assert.equal(n.reference, 'R1');
});

test('normalizeTransaction: accountId precedence override > accountId > accountName', () => {
  const withOverride = normalizeTransaction('bnc', { date: '2026-07-18', amount: 5, description: 'x', type: 'credit', accountId: 'ACC', accountName: 'NAME' }, { accountId: 'OVERRIDE' });
  assert.equal(withOverride.accountId, 'OVERRIDE');
  const withAccountId = normalizeTransaction('bnc', { date: '2026-07-18', amount: 5, description: 'x', type: 'credit', accountId: 'ACC', accountName: 'NAME' });
  assert.equal(withAccountId.accountId, 'ACC');
  const withName = normalizeTransaction('bnc', { date: '2026-07-18', amount: 5, description: 'x', type: 'credit', accountName: 'NAME' });
  assert.equal(withName.accountId, 'NAME');
});

test('normalizeTransaction: raw included by default, omitted when includeRaw=false', () => {
  const withRaw = normalizeTransaction('bnc', { date: '2026-07-18', amount: 5, description: 'x', type: 'credit' });
  assert.ok(withRaw.raw, 'raw present by default');
  const noRaw = normalizeTransaction('bnc', { date: '2026-07-18', amount: 5, description: 'x', type: 'credit' }, { includeRaw: false });
  assert.equal(noRaw.raw, undefined);
});

test('normalizeTransactions: maps every element and preserves order', () => {
  const out = normalizeTransactions('bnc', [
    { date: '2026-07-18', amount: -1, description: 'a', type: 'debit' },
    { date: '2026-07-19', amount: 2, description: 'b', type: 'credit' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].description, 'a');
  assert.equal(out[1].description, 'b');
  assert.equal(out[0].amount, 1);
});
