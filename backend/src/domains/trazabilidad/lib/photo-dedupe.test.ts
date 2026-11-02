/**
 * Pruebas de la deduplicación por clientKey (Properties 1 y 2 del diseño).
 * Ejecutar: node --import tsx --test src/lib/photo-dedupe.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionNewPhotos, existingClientKeys, isDuplicateKey } from './photo-dedupe.js'

test('Property 2: N fotos nuevas con clientKey único → N a insertar, 0 omitidas', () => {
  const existing: Array<{ clientKey?: string }> = []
  const incoming = [
    { clientKey: 'k1' },
    { clientKey: 'k2' },
    { clientKey: 'k3' },
  ]
  const { toInsert, skipped } = partitionNewPhotos(existing, incoming)
  assert.equal(toInsert.length, 3)
  assert.equal(skipped, 0)
})

test('Property 1: reintentar la misma tanda (mismos clientKey) no inserta duplicados', () => {
  const batch = [{ clientKey: 'a' }, { clientKey: 'b' }]
  // Primer intento: todo nuevo.
  const first = partitionNewPhotos([], batch)
  assert.equal(first.toInsert.length, 2)
  // Segundo intento (reintento de red): ya existen → nada que insertar.
  const already = first.toInsert // simulan estar ya guardadas
  const second = partitionNewPhotos(already, batch)
  assert.equal(second.toInsert.length, 0)
  assert.equal(second.skipped, 2)
})

test('duplicados dentro de la MISMA tanda se insertan una sola vez', () => {
  const incoming = [{ clientKey: 'x' }, { clientKey: 'x' }, { clientKey: 'y' }]
  const { toInsert, skipped } = partitionNewPhotos([], incoming)
  assert.equal(toInsert.length, 2) // x, y
  assert.equal(skipped, 1)         // la x repetida
})

test('fotos SIN clientKey nunca se tratan como duplicadas', () => {
  const existing = [{ clientKey: 'k' }]
  const incoming = [{}, {}, { clientKey: 'k' }]
  const { toInsert, skipped } = partitionNewPhotos(existing, incoming)
  assert.equal(toInsert.length, 2) // las dos sin clientKey
  assert.equal(skipped, 1)         // la que repite 'k'
})

test('helpers existingClientKeys / isDuplicateKey', () => {
  const set = existingClientKeys([{ clientKey: 'a' }, {}, { clientKey: 'b' }])
  assert.equal(set.size, 2)
  assert.equal(isDuplicateKey(set, 'a'), true)
  assert.equal(isDuplicateKey(set, 'z'), false)
  assert.equal(isDuplicateKey(set, undefined), false)
})
