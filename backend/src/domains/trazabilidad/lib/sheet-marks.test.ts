import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyTargetSheet, sheetScopedRowKey } from './sheet-marks'

test('sin fila concreta, la marca queda en la tabla', () => {
  assert.equal(sheetScopedRowKey('', 'S1'), 'S1')
  assert.equal(sheetScopedRowKey('  ', 'S2'), 'S2')
})

test('una fila concreta se respeta', () => {
  assert.equal(sheetScopedRowKey('S1:2', 'S1'), 'S1:2')
})

test('sin tabla se mantiene la marca del código (registros sin DATA)', () => {
  assert.equal(sheetScopedRowKey('', undefined), '')
  assert.equal(sheetScopedRowKey('', ''), '')
})

test('tabla de una marca antigua: marca > historial > principal', () => {
  assert.equal(legacyTargetSheet('A', 'B', 'P'), 'A')
  assert.equal(legacyTargetSheet(undefined, 'B', 'P'), 'B')
  assert.equal(legacyTargetSheet('', '', 'P'), 'P')
  assert.equal(legacyTargetSheet(), '')
})
