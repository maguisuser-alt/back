import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendRows, normKey } from './append-rows.js'

const H = ['Código', 'Descripción', 'Und']
const R = [['A1', 'Nevera', '1'], ['A2', 'Estufa', '2']]

test('empareja columnas por nombre sin importar orden, mayúsculas ni tildes', () => {
  const r = appendRows(H, R, ['UND', 'CODIGO', 'descripcion'], [['3', 'A3', 'Horno']])
  assert.deepEqual(r.rows[2], ['A3', 'Horno', '3'])
  assert.equal(r.added, 1)
  assert.deepEqual(r.newColumns, [])
})

test('columnas nuevas se agregan al final y las filas viejas quedan con la celda vacía', () => {
  const r = appendRows(H, R, ['Código', 'Lote'], [['A3', 'L-9']])
  assert.deepEqual(r.headers, ['Código', 'Descripción', 'Und', 'Lote'])
  assert.deepEqual(r.rows[0], ['A1', 'Nevera', '1', ''])
  assert.deepEqual(r.rows[2], ['A3', '', '', 'L-9'])
  assert.deepEqual(r.newColumns, ['Lote'])
})

test('addNewColumns=false descarta las columnas que no existen', () => {
  const r = appendRows(H, R, ['Código', 'Lote'], [['A3', 'L-9']], { addNewColumns: false })
  assert.deepEqual(r.headers, H)
  assert.deepEqual(r.rows[2], ['A3', '', ''])
  assert.deepEqual(r.ignoredColumns, ['Lote'])
})

test('skipDuplicates no agrega códigos que ya están (ni repetidos en el documento)', () => {
  const r = appendRows(H, R, H, [['a1', 'Otra', '1'], ['A3', 'Horno', '1'], ['A3 ', 'Horno bis', '1']], { codeColumn: 0, skipDuplicates: true })
  assert.equal(r.added, 1)
  assert.equal(r.skippedDuplicates, 2)
  assert.equal(r.rows.length, 3)
})

test('sin skipDuplicates sí agrega repetidos; filas vacías nunca', () => {
  const r = appendRows(H, R, H, [['A1', 'x', '1'], ['', '', ''], []])
  assert.equal(r.added, 1)
  assert.equal(r.skippedEmpty, 2)
})

test('normKey', () => {
  assert.equal(normKey('  Código  Ítem '), 'codigo item')
})
