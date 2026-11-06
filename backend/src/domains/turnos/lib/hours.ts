/**
 * Cálculo puro de horas trabajadas y recargos de un turno (sin acceso a base de datos).
 * Lo usa `registerHorasTurno`; vive aparte para poder probarse de forma aislada.
 */
import { nightHoursBetween } from './geo.js'

/** Festivos de Colombia. OJO: solo está cargado 2026; otros años no detectan festivos. */
export const FESTIVOS_COLOMBIA = new Set([
  '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03',
  '2026-05-01', '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29',
  '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02',
  '2026-11-16', '2026-12-08', '2026-12-25',
])

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

/** Día de la semana (en español, sin tildes) de una fecha YYYY-MM-DD. */
export function getDiaSemana(fecha: string): string {
  return DIAS[new Date(fecha + 'T12:00:00').getDay()] ?? ''
}

const round2 = (n: number) => Math.round(n * 100) / 100

export type ComputeHoursParams = {
  fecha: string
  /** ISO de la entrada. */
  checkIn: string
  /** ISO de la salida; sin salida no hay horas. */
  checkOut?: string
  valorHora?: number
  recargoDominical?: number
  recargoFestivo?: number
  recargoNocturno?: number
  jornadaOrdinaria?: number
  timezone?: string
  nocturnoInicioHora?: number
  nocturnoFinHora?: number
}

export function computeHours(p: ComputeHoursParams) {
  const recargoDominical = p.recargoDominical ?? 75
  const recargoFestivo = p.recargoFestivo ?? 100
  const recargoNocturno = p.recargoNocturno ?? 35
  const jornadaOrdinaria = p.jornadaOrdinaria ?? 8
  const timezone = p.timezone ?? 'America/Bogota'
  const { valorHora } = p

  let horasTrabajadas = 0
  if (p.checkIn && p.checkOut) {
    const diff = new Date(p.checkOut).getTime() - new Date(p.checkIn).getTime()
    horasTrabajadas = diff > 0 ? round2(diff / 3_600_000) : 0
  }

  const diaSemana = getDiaSemana(p.fecha)
  const esDominical = diaSemana === 'domingo'
  const esFestivo = FESTIVOS_COLOMBIA.has(p.fecha)

  // Festivo tiene prioridad sobre dominical; ambos excluyen "ordinarias"
  let horasOrdinarias = 0, horasDominicales = 0, horasFestivas = 0
  if (esFestivo) horasFestivas = horasTrabajadas
  else if (esDominical) horasDominicales = horasTrabajadas
  else horasOrdinarias = horasTrabajadas

  const horasNocturnas = p.checkIn && p.checkOut
    ? nightHoursBetween(new Date(p.checkIn).getTime(), new Date(p.checkOut).getTime(), timezone, p.nocturnoInicioHora ?? 19, p.nocturnoFinHora ?? 6)
    : 0
  const horasExtra = Math.max(0, round2(horasTrabajadas - jornadaOrdinaria))

  const subtotalNocturno = valorHora ? round2(horasNocturnas * valorHora * (recargoNocturno / 100)) : undefined
  const subtotalOrdinario = valorHora ? round2(horasOrdinarias * valorHora) : undefined
  const subtotalDominical = valorHora ? round2(horasDominicales * valorHora * (1 + recargoDominical / 100)) : undefined
  const subtotalFestivo = valorHora ? round2(horasFestivas * valorHora * (1 + recargoFestivo / 100)) : undefined
  const subtotal = valorHora
    ? (subtotalOrdinario ?? 0) + (subtotalDominical ?? 0) + (subtotalFestivo ?? 0) + (subtotalNocturno ?? 0)
    : undefined

  return {
    diaSemana, esDominical, esFestivo,
    horasTrabajadas, horasOrdinarias, horasDominicales, horasFestivas,
    horasNocturnas, horasExtra,
    recargoDominical, recargoFestivo, recargoNocturno,
    subtotalOrdinario, subtotalDominical, subtotalFestivo, subtotalNocturno, subtotal,
  }
}
