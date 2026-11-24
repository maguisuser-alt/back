import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldsFromDescription, findMarkedRow, selectedFields } from './mark-fields'
import { markEvent } from './activity-feed'

test('la marca en la actividad lleva las columnas elegidas', () => {
  const ev = markEvent(
    { id: 'h1', productCode: 'A-1', before: 0, after: 2, at: '2026-11-24T10:00:00Z', sheetId: 'S1', rowKey: 'S1', trackingCode: 'OP-1' },
    { sheets: new Map([['S1', 'Tabla']]), scopes: new Map(), fieldsOf: () => [{ label: 'Cliente', value: 'Ana' }] },
  )
  assert.deepEqual(ev?.fields, [{ label: 'Cliente', value: 'Ana' }])
  const none = markEvent(
    { id: 'h2', productCode: 'A-1', before: 0, after: 1, at: '2026-11-24T10:00:00Z' },
    { sheets: new Map(), scopes: new Map() },
  )
  assert.equal(none?.fields, undefined)
})

const headers = ['Código', 'Descripción', 'Cliente', 'Cant', 'Orden']
const rows = [
  ['A-1', 'Nevera LG', 'Ana', '2', 'OC-1'],
  ['B-2', 'Horno', 'Luis', '1', 'OC-2'],
  ['b-2 ', 'Horno grande', 'Eva', '1', 'OC-3'],
]

test('fila de la marca por código y número de aparición', () => {
  assert.equal(findMarkedRow(rows, 0, 'a-1', 'S1')?.[1], 'Nevera LG')
  assert.equal(findMarkedRow(rows, 0, 'B-2', 'S1:2')?.[1], 'Horno grande')
  assert.equal(findMarkedRow(rows, 0, 'B-2', '')?.[1], 'Horno')
  assert.equal(findMarkedRow(rows, 0, 'Z-9', 'S1'), null)
  assert.equal(findMarkedRow(rows, 0, 'B-2', 'S1:5'), null)
})

test('solo las columnas elegidas, descripción primero, sin el código ni vacías', () => {
  const f = selectedFields(rows[0], headers, { codeColumn: 0, descColumn: 1, extraColumns: [4, 2, 0, 1] })
  assert.deepEqual(f, [
    { label: 'Descripción', value: 'Nevera LG' },
    { label: 'Orden', value: 'OC-1' },
    { label: 'Cliente', value: 'Ana' },
  ])
  assert.deepEqual(selectedFields(['X', ''], ['Código', 'Desc'], { codeColumn: 0, descColumn: 1 }), [])
})

test('descripción guardada en el registro como campos', () => {
  assert.deepEqual(fieldsFromDescription('Nevera LG · Cliente: Ana · Orden: OC-1'), [
    { label: 'Descripción', value: 'Nevera LG' },
    { label: 'Cliente', value: 'Ana' },
    { label: 'Orden', value: 'OC-1' },
  ])
  assert.deepEqual(fieldsFromDescription(''), [])
})
