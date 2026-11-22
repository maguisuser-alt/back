import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mainDescription, resolveProductCode, variantCode } from './product-variant'

const A = { productCode: 'OC-1', labelData: { descripcion: 'Nevera LG · Cliente: Ana' } }

test('código libre se usa tal cual', () => {
  assert.deepEqual(resolveProductCode([], 'OC-1', 'Nevera', true), { ok: true, productCode: 'OC-1' })
})

test('mismo código sin permiso es conflicto (comportamiento anterior)', () => {
  const r = resolveProductCode([A], 'oc-1', 'Lavadora', false)
  assert.equal(r.ok, false)
})

test('mismo código con otra descripción crea la variante', () => {
  const r = resolveProductCode([A], 'OC-1', 'Lavadora Samsung · Cliente: Ana', true)
  assert.deepEqual(r, { ok: true, productCode: 'OC-1 · LAVADORA SAMSUNG', orderCode: 'OC-1' })
})

test('mismo código y misma descripción es el mismo producto', () => {
  assert.equal(resolveProductCode([A], 'OC-1', 'nevera lg · Cliente: Otro', true).ok, false)
  const B = { productCode: 'OC-1 · LAVADORA', orderCode: 'OC-1', labelData: { descripcion: 'Lavadora' } }
  assert.equal(resolveProductCode([A, B], 'OC-1', 'Lavadora', true).ok, false)
})

test('sin descripción no se puede distinguir', () => {
  assert.equal(resolveProductCode([A], 'OC-1', '', true).ok, false)
})

test('helpers', () => {
  assert.equal(mainDescription('Nevera  LG · Cliente: x'), 'Nevera LG')
  assert.equal(variantCode(' oc-1 ', 'Horno'), 'OC-1 · HORNO')
})
