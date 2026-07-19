import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientBanescoError } from '../src/banks/banesco/auth/login-verifier.js';

// Locks the pure transient-vs-permanent error classification extracted from
// BanescoAuth's verifier. Transient outages are retried by BanescoAuth.login();
// permanent errors (bad password, etc.) must NOT be classified transient.

test('isTransientBanescoError: outage message text is transient', () => {
  assert.equal(
    isTransientBanescoError('En estos momentos no podemos procesar su operación', null),
    true,
  );
  assert.equal(isTransientBanescoError('Por favor intente más tarde', null), true);
  assert.equal(isTransientBanescoError('Intente mas tarde', null), true); // no accent
});

test('isTransientBanescoError: GU*-style error codes are transient', () => {
  assert.equal(isTransientBanescoError('Some message', 'GUEG001'), true);
  assert.equal(isTransientBanescoError('', 'GU1234'), true);
});

test('isTransientBanescoError: permanent errors are NOT transient', () => {
  assert.equal(isTransientBanescoError('Contraseña incorrecta', null), false);
  assert.equal(isTransientBanescoError('Usuario bloqueado', 'ABC123'), false);
  assert.equal(isTransientBanescoError('', null), false);
});
