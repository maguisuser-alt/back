import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeItems, routeLine, totals, totalsLine } from './operation-summary'

const url = 'https://x/a.jpg'

test('con origen y destino se muestran los dos', () => {
  const op = { origin: { type: 'vehiculo', name: 'NUY756' }, destination: { type: 'lugar', name: 'Europark - Ditransa' } }
  assert.deepEqual(routeItems(op), [
    { label: 'Origen', value: '🚚 NUY756' },
    { label: 'Destino', value: 'Europark - Ditransa' },
  ])
  assert.equal(routeLine(op), '📍 Origen: 🚚 NUY756 → Destino: Europark - Ditransa')
})

test('solo destino (o locationName antiguo) se muestra como Lugar', () => {
  assert.equal(routeLine({ destination: { type: 'lugar', name: 'Europark' } }), '📍 Lugar: Europark')
  assert.equal(routeLine({ locationName: 'Bodega 2' }), '📍 Lugar: Bodega 2')
  assert.equal(routeLine({}), '')
})

test('totales cuentan fotos generales y de productos (solo imágenes subidas)', () => {
  const op = {
    photos: [{ driveUrl: url }, { driveUrl: url, mediaType: 'audio' }, { driveUrl: 'pending-verification' }],
    lineaBlanca: [{ photos: [{ driveUrl: url }, { driveUrl: url }] }, { photos: [] }],
  }
  assert.deepEqual(totals(op), { photos: 3, products: 2 })
  assert.equal(totalsLine(op), '📷 3 foto(s) · 📦 2 producto(s)')
})
