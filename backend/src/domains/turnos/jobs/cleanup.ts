/**
 * Limpieza programada para no llenar el límite de 512 MB de Atlas M0.
 *
 * Solo toca datos de BAJO valor y con fecha de caducidad clara. Nunca borra
 * turnos, horas trabajadas, facturas, usuarios ni asistencia académica.
 *
 *  - faceVerificationLogs: bitácora de verificaciones faciales > 90 días.
 *  - turnSwaps cerradas (aprobada/rechazada/cancelada) > 180 días.
 *  - whatsapp_turnos_messages > 60 días (mensajes entrantes persistidos).
 *
 * Es configurable con CLEANUP_* (días) y se puede apagar con CLEANUP_ENABLED=false.
 * Corre como máximo una vez cada 24 h por proceso.
 */
import { getDb, getFaceVerificationLogsCollection } from '../lib/mongodb.js'

const DAY_MS = 86_400_000
const RUN_EVERY_MS = 24 * 60 * 60 * 1000

function days(envName: string, fallback: number): number {
  const n = Number(process.env[envName])
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : fallback // mínimo 7 días por seguridad
}

const cutoffIso = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString()

export async function runCleanup(): Promise<void> {
  if (process.env.CLEANUP_ENABLED === 'false') return

  const faceDays = days('CLEANUP_FACE_LOGS_DAYS', 90)
  const swapDays = days('CLEANUP_SWAPS_DAYS', 180)
  const msgDays = days('CLEANUP_WHATSAPP_MESSAGES_DAYS', 60)

  const db = await getDb()
  const results: string[] = []

  try {
    const r = await (await getFaceVerificationLogsCollection()).deleteMany({ createdAt: { $lt: cutoffIso(faceDays) } } as any)
    if (r.deletedCount) results.push(`${r.deletedCount} log(s) faciales`)
  } catch (e) { console.warn('[cleanup] faceVerificationLogs:', e instanceof Error ? e.message : e) }

  try {
    const r = await db.collection('turnSwaps').deleteMany({
      estado: { $in: ['aprobada', 'rechazada', 'cancelada'] },
      updatedAt: { $lt: cutoffIso(swapDays) },
    } as any)
    if (r.deletedCount) results.push(`${r.deletedCount} permuta(s) cerrada(s)`)
  } catch (e) { console.warn('[cleanup] turnSwaps:', e instanceof Error ? e.message : e) }

  try {
    const r = await db.collection('whatsapp_turnos_messages').deleteMany({ createdAt: { $lt: cutoffIso(msgDays) } } as any)
    if (r.deletedCount) results.push(`${r.deletedCount} mensaje(s) de WhatsApp`)
  } catch (e) { console.warn('[cleanup] whatsapp_turnos_messages:', e instanceof Error ? e.message : e) }

  if (results.length) console.log(`[cleanup] Eliminados: ${results.join(', ')}.`)
}

export const CLEANUP_INTERVAL_MS = RUN_EVERY_MS
