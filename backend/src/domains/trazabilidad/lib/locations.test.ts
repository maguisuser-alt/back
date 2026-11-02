import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlaca, sameLocation, toLocationRef, decideMovement, locationLabel } from './locations.ts'
import type { CompanyLocation, LocationRef } from '../types.ts'

const PLACES: CompanyLocation[] = [
  { id: 'loc-a', name: 'Bodega Norte' },
  { id: 'loc-b', name: 'Local Centro', city: 'Bogotá' },
]

// ── normalizePlaca ──────────────────────────────────────────────────────
test('normalizePlaca: mayúsculas y sin espacios/guiones', () => {
  assert.equal(normalizePlaca(' abc-123 '), 'ABC123')
  assert.equal(normalizePlaca('xyz 789'), 'XYZ789')
  assert.equal(normalizePlaca(''), '')
  assert.equal(normalizePlaca(undefined), '')
})

// ── toLocationRef ───────────────────────────────────────────────────────
test('toLocationRef: lugar existente → ref con nombre del lugar', () => {
  const ref = toLocationRef({ type: 'lugar', id: 'loc-a' }, PLACES)
  assert.deepEqual(ref, { type: 'lugar', id: 'loc-a', name: 'Bodega Norte' })
})

test('toLocationRef: lugar inexistente → null', () => {
  assert.equal(toLocationRef({ type: 'lugar', id: 'nope' }, PLACES), null)
})

test('toLocationRef: vehículo → placa normalizada como name', () => {
  const ref = toLocationRef({ type: 'vehiculo', placa: 'abc-123' }, PLACES)
  assert.deepEqual(ref, { type: 'vehiculo', placa: 'ABC123', name: 'ABC123' })
})

test('toLocationRef: entradas inválidas → null', () => {
  assert.equal(toLocationRef(null, PLACES), null)
  assert.equal(toLocationRef({ type: 'otro' }, PLACES), null)
  assert.equal(toLocationRef({ type: 'lugar' }, PLACES), null)
  assert.equal(toLocationRef({ type: 'vehiculo', placa: '  ' }, PLACES), null)
})

// ── sameLocation ────────────────────────────────────────────────────────
test('sameLocation: igual lugar por id', () => {
  const a: LocationRef = { type: 'lugar', id: 'loc-a', name: 'Bodega Norte' }
  const b: LocationRef = { type: 'lugar', id: 'loc-a', name: 'Otro nombre' }
  assert.equal(sameLocation(a, b), true)
})

test('sameLocation: igual vehículo por placa normalizada', () => {
  const a: LocationRef = { type: 'vehiculo', placa: 'ABC123', name: 'ABC123' }
  const b: LocationRef = { type: 'vehiculo', placa: 'abc-123', name: 'abc-123' }
  assert.equal(sameLocation(a, b), true)
})

test('sameLocation: tipos distintos o null → false', () => {
  const lugar: LocationRef = { type: 'lugar', id: 'loc-a', name: 'Bodega Norte' }
  const veh: LocationRef = { type: 'vehiculo', placa: 'ABC123', name: 'ABC123' }
  assert.equal(sameLocation(lugar, veh), false)
  assert.equal(sameLocation(null, lugar), false)
  assert.equal(sameLocation(lugar, null), false)
  assert.equal(sameLocation(null, null), false)
})

// ── locationLabel ───────────────────────────────────────────────────────
test('locationLabel: nombre del lugar o placa; null → Sin ubicación', () => {
  assert.equal(locationLabel({ type: 'lugar', id: 'loc-a', name: 'Bodega Norte' }), 'Bodega Norte')
  assert.equal(locationLabel({ type: 'vehiculo', placa: 'ABC123', name: 'ABC123' }), 'ABC123')
  assert.equal(locationLabel(null), 'Sin ubicación')
})

// ── decideMovement ──────────────────────────────────────────────────────
const LUGAR_A: LocationRef = { type: 'lugar', id: 'loc-a', name: 'Bodega Norte' }
const LUGAR_B: LocationRef = { type: 'lugar', id: 'loc-b', name: 'Local Centro' }
const VEH: LocationRef = { type: 'vehiculo', placa: 'ABC123', name: 'ABC123' }

test('decideMovement: sin ubicación + destino → registra con from=null', () => {
  const d = decideMovement(null, LUGAR_A, null)
  assert.equal(d.shouldRecord, true)
  assert.equal(d.from, null)
  assert.equal(d.inferred, false)
})

test('decideMovement: ubicación distinta + destino → traspaso inferido', () => {
  const d = decideMovement(LUGAR_A, LUGAR_B, null)
  assert.equal(d.shouldRecord, true)
  assert.deepEqual(d.from, LUGAR_A)
  assert.equal(d.inferred, true)
})

test('decideMovement: ubicación igual al destino → no-op', () => {
  const d = decideMovement(LUGAR_A, { type: 'lugar', id: 'loc-a', name: 'x' }, null)
  assert.equal(d.shouldRecord, false)
})

test('decideMovement: origen explícito → inferred=false y respeta el origen', () => {
  const d = decideMovement(LUGAR_A, LUGAR_B, VEH)
  assert.equal(d.shouldRecord, true)
  assert.deepEqual(d.from, VEH)
  assert.equal(d.inferred, false)
})

test('decideMovement: vehículo a lugar (cambio) → registra', () => {
  const d = decideMovement(VEH, LUGAR_A, null)
  assert.equal(d.shouldRecord, true)
  assert.deepEqual(d.from, VEH)
  assert.equal(d.inferred, true)
})
