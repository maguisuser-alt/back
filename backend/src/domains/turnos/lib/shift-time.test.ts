import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { zonedTimeToMs } from './geo.js'
import { MAX_OFFLINE_EXIT_AGE_MS, resolveExitTime, turnRangeMs } from './shift-time.js'

const TZ = 'America/Bogota'

describe('turnRangeMs', () => {
  it('turno diurno 08:00-16:00 dura 8 h', () => {
    const r = turnRangeMs({ fecha: '2026-03-10', hora: '08:00', horaFin: '16:00' }, TZ)
    assert.ok(r)
    assert.equal(r.endMs - r.startMs, 8 * 3_600_000)
  })

  it('turno nocturno 22:00-06:00 termina al día siguiente (8 h)', () => {
    const r = turnRangeMs({ fecha: '2026-03-10', hora: '22:00', horaFin: '06:00' }, TZ)
    assert.ok(r)
    assert.equal(r.endMs - r.startMs, 8 * 3_600_000)
    assert.equal(r.startMs, zonedTimeToMs('2026-03-10', '22:00', TZ))
  })

  it('inicio y fin iguales se toman como 24 h', () => {
    const r = turnRangeMs({ fecha: '2026-03-10', hora: '08:00', horaFin: '08:00' }, TZ)
    assert.ok(r)
    assert.equal(r.endMs - r.startMs, 24 * 3_600_000)
  })

  it('sin horaFin, sin hora o con hora inválida devuelve null', () => {
    assert.equal(turnRangeMs({ fecha: '2026-03-10', hora: '08:00' }, TZ), null)
    assert.equal(turnRangeMs({ fecha: '2026-03-10', horaFin: '16:00' }, TZ), null)
    assert.equal(turnRangeMs({ hora: '08:00', horaFin: '16:00' }, TZ), null)
    assert.equal(turnRangeMs({ fecha: '2026-03-10', hora: '08:00', horaFin: 'xx:yy' }, TZ), null)
  })
})

describe('resolveExitTime', () => {
  const NOW = Date.parse('2026-03-10T20:00:00.000Z')
  const CHECK_IN = '2026-03-10T13:00:00.000Z'
  const iso = (ms: number) => new Date(ms).toISOString()

  it('sin cola sin conexión usa la hora actual aunque el cliente mande otra', () => {
    assert.equal(resolveExitTime('2026-03-10T15:00:00.000Z', false, CHECK_IN, NOW), iso(NOW))
  })

  it('sin hora del cliente usa la hora actual', () => {
    assert.equal(resolveExitTime(undefined, true, CHECK_IN, NOW), iso(NOW))
  })

  it('acepta la hora real del cliente si es válida', () => {
    assert.equal(resolveExitTime('2026-03-10T17:30:00.000Z', true, CHECK_IN, NOW), '2026-03-10T17:30:00.000Z')
  })

  it('rechaza una hora futura (no se pueden inflar horas)', () => {
    assert.equal(resolveExitTime(iso(NOW + 60_000), true, CHECK_IN, NOW), iso(NOW))
  })

  it('rechaza una hora anterior a la entrada', () => {
    assert.equal(resolveExitTime('2026-03-10T12:00:00.000Z', true, CHECK_IN, NOW), iso(NOW))
  })

  it('rechaza una hora de hace más de 72 h', () => {
    assert.equal(resolveExitTime(iso(NOW - MAX_OFFLINE_EXIT_AGE_MS - 1000), true, undefined, NOW), iso(NOW))
  })

  it('acepta una hora justo dentro del límite de 72 h', () => {
    const edge = iso(NOW - MAX_OFFLINE_EXIT_AGE_MS + 1000)
    assert.equal(resolveExitTime(edge, true, undefined, NOW), edge)
  })

  it('rechaza una fecha inválida', () => {
    assert.equal(resolveExitTime('no-es-fecha', true, CHECK_IN, NOW), iso(NOW))
  })

  it('sin hora de entrada conocida no impone cota inferior (salvo las 72 h)', () => {
    assert.equal(resolveExitTime('2026-03-10T10:00:00.000Z', true, undefined, NOW), '2026-03-10T10:00:00.000Z')
  })
})
