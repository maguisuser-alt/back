import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildActivityFeed, markEvent, opTypeLabel, operationEvents } from './activity-feed.js'

const names = { sheets: new Map([['s1', 'OP_MC_BAQ 19-11-2026']]), scopes: new Map([['sc1', 'Carga 19-nov']]) }

test('registro completado muestra tipo, productos y fotos', () => {
  const ev = operationEvents({
    trackingCode: 'TRK1', operationType: 'PRODUCTOS_ENTRANTES', operatorName: 'Ana', status: 'COMPLETADO',
    createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T11:00:00Z', completedAt: '2026-11-19T11:00:00Z',
    productos: 3, fotos: 1,
  })
  assert.deepEqual(ev.map((e) => e.title), ['Registro creado', 'Registro completado'])
  assert.equal(ev[1].detail, 'Productos entrantes · 3 productos · 1 foto')
  assert.equal(ev[1].open, false)
})

test('registro en proceso actualizado (y no "actualizado" si casi no cambió)', () => {
  const upd = operationEvents({
    trackingCode: 'TRK2', status: 'EN_PROCESO', createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:30:00Z',
    productos: 1, fotos: 4, lastProduct: '53-1104712',
  })
  assert.equal(upd[1].title, 'Registro actualizado')
  assert.match(upd[1].detail, /último: 53-1104712/)
  assert.equal(upd[1].open, true)
  const fresh = operationEvents({ trackingCode: 'TRK3', createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:20Z' })
  assert.equal(fresh.length, 1)
})

test('marca en DATA: producto, piezas, tabla y recepción', () => {
  const ev = markEvent({ id: 'h1', productCode: '53-1104712', before: 0, after: 5, user: 'Luis', at: '2026-11-19T12:00:00Z', action: 'mark', sheetId: 's1', scope: 'sc1' }, names)
  assert.ok(ev)
  assert.equal(ev.title, 'Marcado en DATA')
  assert.equal(ev.detail, '53-1104712 · 5 piezas')
  assert.equal(ev.sheetName, 'OP_MC_BAQ 19-11-2026')
  assert.equal(ev.scopeName, 'Carga 19-nov')
  assert.equal(markEvent({ productCode: 'X', before: 5, after: 0, at: '2026-11-19T12:00:00Z' }, names)?.title, 'Desmarcado en DATA')
  assert.equal(markEvent({ productCode: 'X', before: 2, after: 3, at: '2026-11-19T12:00:00Z' }, names)?.title, 'Piezas actualizadas en DATA')
})

test('une todo de lo más nuevo a lo más viejo y respeta el límite', () => {
  const feed = buildActivityFeed({
    ops: [{ trackingCode: 'T', createdAt: '2026-11-19T09:00:00Z', updatedAt: '2026-11-19T09:00:00Z' }],
    history: [{ id: 'h', productCode: 'P', after: 1, at: '2026-11-19T11:00:00Z' }],
    logs: [{ _id: 'l', detail: 'Llegó el camión', createdAt: '2026-11-19T10:00:00Z' }],
    ...names,
    limit: 2,
  })
  assert.deepEqual(feed.map((f) => f.kind), ['data', 'manual'])
})

test('opTypeLabel', () => {
  assert.equal(opTypeLabel('PRODUCTOS_SALIENTES'), 'Productos salientes')
  assert.equal(opTypeLabel(undefined), 'Registro')
})
