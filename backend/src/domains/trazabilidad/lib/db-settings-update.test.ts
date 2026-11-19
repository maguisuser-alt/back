import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDbSettingsUpdate, sanitizeDbSettings } from './db-settings-update.js'

const cols = { codeColumn: 2, descColumn: 3, extraColumns: [4, 5], expectedColumn: 6 }

test('solo actualiza las tablas que vienen (no borra las demás)', () => {
  const { $set, $unset } = buildDbSettingsUpdate({ companyId: 'c1', columns: { abc123: cols } })
  assert.deepEqual($set, { 'dbSettings.columns.abc123': cols })
  assert.deepEqual($unset, {})
  // No toca la tabla principal ni otras tablas.
  assert.ok(!('dbSettings' in $set))
  assert.ok(!('dbSettings.primarySheetId' in $set))
})

test('sin columnas ni principal no cambia nada', () => {
  const { $set, $unset } = buildDbSettingsUpdate({ companyId: 'c1' })
  assert.deepEqual($set, {})
  assert.deepEqual($unset, {})
})

test('primary con id la fija; primary con id null la quita', () => {
  assert.deepEqual(buildDbSettingsUpdate({ primary: { id: 't1', name: 'DATA' } }).$set,
    { 'dbSettings.primarySheetId': 't1', 'dbSettings.primarySheetName': 'DATA' })
  const off = buildDbSettingsUpdate({ primary: { id: null } })
  assert.deepEqual(off.$set, {})
  assert.deepEqual(off.$unset, { 'dbSettings.primarySheetId': '', 'dbSettings.primarySheetName': '' })
})

test('compatibilidad: clientes anteriores con primarySheetId suelto', () => {
  const { $set } = buildDbSettingsUpdate({ primarySheetId: 't9', primarySheetName: 'X', columns: {} })
  assert.equal($set['dbSettings.primarySheetId'], 't9')
  // Cliente anterior SIN principal (undefined) → no la borra.
  assert.deepEqual(buildDbSettingsUpdate({ columns: {} }).$unset, {})
})

test('ignora ids que romperían la ruta de Mongo', () => {
  const { $set } = buildDbSettingsUpdate({ columns: { 'a.b': cols, $x: cols, ok_1: cols } })
  assert.deepEqual(Object.keys($set), ['dbSettings.columns.ok_1'])
})

test('sanitizeDbSettings: conserva el modo de cantidad válido y descarta otros', () => {
  const s = sanitizeDbSettings({ columns: { a: { ...cols, qtyMode: 'expected' }, b: { ...cols, qtyMode: 'x' } } })
  assert.equal(s.columns.a.qtyMode, 'expected')
  assert.equal('qtyMode' in s.columns.b, false)
})

test('sanitizeDbSettings: valores inválidos quedan en los valores por defecto', () => {
  const s = sanitizeDbSettings({ columns: { t: { codeColumn: -3, descColumn: 'x', extraColumns: [1, -1, 'a'] } } })
  assert.deepEqual(s.columns.t, { codeColumn: 0, descColumn: -1, extraColumns: [1], expectedColumn: -1 })
})
