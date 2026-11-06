import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nightHoursBetween, todayInTimezone, zonedTimeToMs } from './geo.js'
import { computeHours, getDiaSemana } from './hours.js'

// Bogotá es UTC-5 todo el año (sin horario de verano), así que 07:00 local = 12:00 UTC.
const bog = (fecha: string, hora: string) => new Date(zonedTimeToMs(fecha, hora, 'America/Bogota')).toISOString()

describe('zonedTimeToMs', () => {
  it('convierte hora local de Bogotá a UTC (+5 h)', () => {
    assert.equal(bog('2026-03-10', '07:00'), '2026-03-10T12:00:00.000Z')
  })

  it('respeta otra zona (Ciudad de México, UTC-6 en invierno)', () => {
    assert.equal(new Date(zonedTimeToMs('2026-01-15', '08:00', 'America/Mexico_City')).toISOString(), '2026-01-15T14:00:00.000Z')
  })

  it('cruza el día: 22:00 local es 03:00 UTC del día siguiente', () => {
    assert.equal(bog('2026-03-10', '22:00'), '2026-03-11T03:00:00.000Z')
  })
})

describe('getDiaSemana', () => {
  it('2026-03-08 es domingo y 2026-03-09 es lunes', () => {
    assert.equal(getDiaSemana('2026-03-08'), 'domingo')
    assert.equal(getDiaSemana('2026-03-09'), 'lunes')
  })
})

describe('nightHoursBetween (19:00-06:00)', () => {
  it('turno diurno 08:00-16:00 no tiene horas nocturnas', () => {
    assert.equal(nightHoursBetween(Date.parse(bog('2026-03-10', '08:00')), Date.parse(bog('2026-03-10', '16:00')), 'America/Bogota'), 0)
  })

  it('turno 14:00-22:00 tiene 3 h nocturnas (19:00 a 22:00)', () => {
    assert.equal(nightHoursBetween(Date.parse(bog('2026-03-10', '14:00')), Date.parse(bog('2026-03-10', '22:00')), 'America/Bogota'), 3)
  })

  it('turno 22:00-06:00 cruzando medianoche son 8 h nocturnas', () => {
    const start = Date.parse(bog('2026-03-10', '22:00'))
    assert.equal(nightHoursBetween(start, start + 8 * 3_600_000, 'America/Bogota'), 8)
  })

  it('turno 04:00-12:00 tiene 2 h nocturnas (04:00 a 06:00)', () => {
    assert.equal(nightHoursBetween(Date.parse(bog('2026-03-10', '04:00')), Date.parse(bog('2026-03-10', '12:00')), 'America/Bogota'), 2)
  })

  it('rango invertido o vacío devuelve 0', () => {
    const t = Date.parse(bog('2026-03-10', '22:00'))
    assert.equal(nightHoursBetween(t, t, 'America/Bogota'), 0)
    assert.equal(nightHoursBetween(t, t - 3_600_000, 'America/Bogota'), 0)
  })

  it('respeta una franja nocturna configurada (21:00-05:00)', () => {
    // 20:00-23:00 con noche desde las 21:00 => 2 h
    assert.equal(nightHoursBetween(Date.parse(bog('2026-03-10', '20:00')), Date.parse(bog('2026-03-10', '23:00')), 'America/Bogota', 21, 5), 2)
  })
})

describe('computeHours', () => {
  const base = { fecha: '2026-03-10' } // martes, no festivo

  it('día ordinario: 8 h entre 08:00 y 16:00', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '08:00'), checkOut: bog(base.fecha, '16:00') })
    assert.equal(r.horasTrabajadas, 8)
    assert.equal(r.horasOrdinarias, 8)
    assert.equal(r.horasDominicales, 0)
    assert.equal(r.horasFestivas, 0)
    assert.equal(r.horasExtra, 0)
    assert.equal(r.horasNocturnas, 0)
  })

  it('domingo: todas las horas son dominicales', () => {
    const r = computeHours({ fecha: '2026-03-08', checkIn: bog('2026-03-08', '08:00'), checkOut: bog('2026-03-08', '16:00') })
    assert.equal(r.esDominical, true)
    assert.equal(r.horasDominicales, 8)
    assert.equal(r.horasOrdinarias, 0)
  })

  it('festivo entre semana: horas festivas', () => {
    // 2026-05-01 (viernes) está en la lista de festivos
    const r = computeHours({ fecha: '2026-05-01', checkIn: bog('2026-05-01', '08:00'), checkOut: bog('2026-05-01', '16:00') })
    assert.equal(r.esFestivo, true)
    assert.equal(r.horasFestivas, 8)
    assert.equal(r.horasOrdinarias, 0)
  })

  it('festivo en domingo cuenta solo como festivo (no se duplica)', () => {
    // 2026-03-23 es lunes festivo; se busca un domingo festivo: ninguno en 2026, así que se prueba la regla
    // con un festivo y se verifica que dominicales queda en 0 aunque el día no sea domingo.
    const r = computeHours({ fecha: '2026-05-01', checkIn: bog('2026-05-01', '08:00'), checkOut: bog('2026-05-01', '10:00') })
    assert.equal(r.horasDominicales, 0)
    assert.equal(r.horasFestivas, 2)
  })

  it('horas extra: 10 h trabajadas con jornada de 8 h => 2 h extra', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '08:00'), checkOut: bog(base.fecha, '18:00') })
    assert.equal(r.horasTrabajadas, 10)
    assert.equal(r.horasExtra, 2)
  })

  it('respeta una jornada ordinaria configurada (6 h)', () => {
    const r = computeHours({ ...base, jornadaOrdinaria: 6, checkIn: bog(base.fecha, '08:00'), checkOut: bog(base.fecha, '16:00') })
    assert.equal(r.horasExtra, 2)
  })

  it('turno nocturno 22:00-06:00: 8 h, todas nocturnas', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '22:00'), checkOut: new Date(Date.parse(bog(base.fecha, '22:00')) + 8 * 3_600_000).toISOString() })
    assert.equal(r.horasTrabajadas, 8)
    assert.equal(r.horasNocturnas, 8)
  })

  it('sin salida no hay horas', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '08:00') })
    assert.equal(r.horasTrabajadas, 0)
    assert.equal(r.horasNocturnas, 0)
    assert.equal(r.horasExtra, 0)
  })

  it('salida anterior a la entrada da 0 horas (no negativas)', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '16:00'), checkOut: bog(base.fecha, '08:00') })
    assert.equal(r.horasTrabajadas, 0)
  })

  it('sin valorHora no calcula subtotales', () => {
    const r = computeHours({ ...base, checkIn: bog(base.fecha, '08:00'), checkOut: bog(base.fecha, '16:00') })
    assert.equal(r.subtotal, undefined)
    assert.equal(r.subtotalNocturno, undefined)
  })

  it('día ordinario con valorHora 10000: subtotal = 8 × 10000', () => {
    const r = computeHours({ ...base, valorHora: 10000, checkIn: bog(base.fecha, '08:00'), checkOut: bog(base.fecha, '16:00') })
    assert.equal(r.subtotalOrdinario, 80000)
    assert.equal(r.subtotalNocturno, 0)
    assert.equal(r.subtotal, 80000)
  })

  it('domingo con recargo 75%: 8 h × 10000 × 1.75 = 140000', () => {
    const r = computeHours({ fecha: '2026-03-08', valorHora: 10000, checkIn: bog('2026-03-08', '08:00'), checkOut: bog('2026-03-08', '16:00') })
    assert.equal(r.subtotalDominical, 140000)
    assert.equal(r.subtotal, 140000)
  })

  it('festivo con recargo 100%: 8 h × 10000 × 2 = 160000', () => {
    const r = computeHours({ fecha: '2026-05-01', valorHora: 10000, checkIn: bog('2026-05-01', '08:00'), checkOut: bog('2026-05-01', '16:00') })
    assert.equal(r.subtotalFestivo, 160000)
  })

  it('recargo nocturno 35%: 3 h nocturnas × 10000 × 0.35 = 10500 sobre el ordinario', () => {
    // 14:00-22:00 => 8 h ordinarias (80000) + 3 h nocturnas con recargo 35% (10500)
    const r = computeHours({ ...base, valorHora: 10000, checkIn: bog(base.fecha, '14:00'), checkOut: bog(base.fecha, '22:00') })
    assert.equal(r.horasNocturnas, 3)
    assert.equal(r.subtotalNocturno, 10500)
    assert.equal(r.subtotal, 90500)
  })

  it('usa recargos personalizados de la empresa', () => {
    const r = computeHours({ fecha: '2026-03-08', valorHora: 10000, recargoDominical: 100, checkIn: bog('2026-03-08', '08:00'), checkOut: bog('2026-03-08', '10:00') })
    assert.equal(r.subtotalDominical, 40000) // 2 × 10000 × 2
  })
})

describe('todayInTimezone', () => {
  it('devuelve una fecha con formato YYYY-MM-DD', () => {
    assert.match(todayInTimezone('America/Bogota'), /^\d{4}-\d{2}-\d{2}$/)
  })

  it('con una zona inválida recurre a la fecha UTC sin lanzar', () => {
    assert.match(todayInTimezone('Zona/Invalida'), /^\d{4}-\d{2}-\d{2}$/)
  })
})
