/**
 * Reglas de tiempo de un turno, puras (sin base de datos) para poder probarlas.
 */
import { zonedTimeToMs } from './geo.js'

/** Antigüedad máxima aceptada para una salida marcada sin conexión. */
export const MAX_OFFLINE_EXIT_AGE_MS = 72 * 3_600_000

/**
 * Inicio y fin (ms UTC) de un turno en la zona horaria dada.
 * Si la hora de fin es menor o igual a la de inicio, el turno cruza medianoche
 * (el fin cae al día siguiente). Devuelve null si faltan datos o son inválidos.
 */
export function turnRangeMs(
  turn: { fecha?: string; hora?: string; horaFin?: string },
  timezone: string,
): { startMs: number; endMs: number } | null {
  if (!turn.horaFin || !turn.fecha || !turn.hora) return null
  const [eh, em] = turn.horaFin.split(':').map(Number)
  if (Number.isNaN(eh) || Number.isNaN(em)) return null
  const startMs = zonedTimeToMs(turn.fecha, turn.hora, timezone)
  let endMs = zonedTimeToMs(turn.fecha, turn.horaFin, timezone)
  if (endMs <= startMs) endMs += 24 * 3_600_000
  return { startMs, endMs }
}

/**
 * Hora de la salida. Normalmente es "ahora". Si viene de la cola sin conexión se acepta la hora
 * real del cliente, pero acotada: nunca en el futuro (no se pueden inflar horas), nunca antes de
 * la entrada y nunca de hace más de 72 h. Si no cumple, se usa "ahora".
 */
export function resolveExitTime(
  clientMarkedAt: string | undefined,
  offlineQueued: boolean | undefined,
  checkInAt: string | undefined,
  nowMs: number = Date.now(),
): string {
  if (!offlineQueued || !clientMarkedAt) return new Date(nowMs).toISOString()
  const ms = Date.parse(clientMarkedAt)
  if (Number.isNaN(ms)) return new Date(nowMs).toISOString()
  const checkInMs = checkInAt ? Date.parse(checkInAt) : Number.NEGATIVE_INFINITY
  if (ms > nowMs || ms < checkInMs || nowMs - ms > MAX_OFFLINE_EXIT_AGE_MS) return new Date(nowMs).toISOString()
  return new Date(ms).toISOString()
}
