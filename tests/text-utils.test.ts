import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripAccents,
  normalizeText,
  parseVesAmount,
  extractPostBack,
  toMessage,
} from '../src/shared/utils/text.js';

test('stripAccents: removes diacritics, keeps base letters', () => {
  assert.equal(stripAccents('Descripción Móvil áéíóúñ'), 'Descripcion Movil aeioun');
});

test('normalizeText: lowercases, strips accents and Spanish punctuation', () => {
  assert.equal(normalizeText('¿Cuál es tu MASCOTA?'), 'cual es tu mascota');
  assert.equal(normalizeText('  ¡Hola!  '), 'hola');
});

test('parseVesAmount: Venezuelan format (dot thousands, comma decimal)', () => {
  assert.equal(parseVesAmount('1.234,56'), 1234.56);
  assert.equal(parseVesAmount('-1.234,56'), -1234.56);
  assert.equal(parseVesAmount('Bs. 2.000,00'), 2000);
});

test('parseVesAmount: US format and plain integers', () => {
  assert.equal(parseVesAmount('1,234.56'), 1234.56);
  assert.equal(parseVesAmount('2000'), 2000);
  assert.equal(parseVesAmount('50,00'), 50); // single comma = decimal
});

test('parseVesAmount: non-numeric input yields 0', () => {
  assert.equal(parseVesAmount(''), 0);
  assert.equal(parseVesAmount(null), 0);
  assert.equal(parseVesAmount('N/A'), 0);
});

test('extractPostBack: pulls target and arg from a __doPostBack call', () => {
  assert.deepEqual(extractPostBack("x __doPostBack('ctl00$grid','Select$3') y"), {
    target: 'ctl00$grid',
    arg: 'Select$3',
  });
  assert.deepEqual(extractPostBack("__doPostBack('ctl00$btn','')"), { target: 'ctl00$btn', arg: '' });
  assert.equal(extractPostBack('no postback here'), null);
});

test('toMessage: narrows Error vs non-Error', () => {
  assert.equal(toMessage(new Error('boom')), 'boom');
  assert.equal(toMessage('raw string'), 'raw string');
  assert.equal(toMessage(42), '42');
});
