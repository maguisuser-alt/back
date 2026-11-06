/**
 * Job de recordatorios de turno por WhatsApp.
 *
 * - Solo actúa si el canal está activo (ENABLE_WHATSAPP_TURNOS=true).
 * - Solo para empresas que activaron la plantilla `turno_recordatorio`
 *   (viene desactivada por defecto).
 * - Avisa `recordatorioMinutosAntes` (default 60) antes del inicio del turno.
 * - Marca `reminderSentAt` solo tras un envío exitoso, para no duplicar y
 *   para reintentar en el siguiente ciclo si WhatsApp no estaba conectado.
 * - Espera entre mensajes para no enviar ráfagas (reduce riesgo de bloqueo).
 */
import { zonedTimeToMs } from '../lib/geo.js'
import {
  getCompaniesCollection,
  getDb,
  getLocationsCollection,
  getTurnsCollection,
  getUsersCollection,
} from '../lib/mongodb.js'
import { getStatus, isWhatsAppTurnosEnabled } from '../lib/whatsapp-turnos.js'
import { sendTemplate } from '../lib/whatsapp-templates.js'
import { DEFAULT_CONFIG } from '../routes/whatsapp-config.js'
import type { Company, Location, Turn, User } from '../types.js'

const DEFAULT_TIMEZONE = 'America/Bogota'
const DEFAULT_MINUTES_BEFORE = 60
const DELAY_BETWEEN_MESSAGES_MS = 2_000
const MAX_PER_RUN = 30

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fecha YYYY-MM-DD desplazada `days` días (en UTC; solo se usa para acotar la consulta). */
function shiftDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

async function isReminderEnabled(companyId: string): Promise<boolean> {
  try {
    const db = await getDb()
    const doc = (await db.collection('whatsapp_turnos_config').findOne({ companyId })) as Record<string, any> | null
    const enabled = doc?.turno_recordatorio?.enabled
    return typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.turno_recordatorio.enabled
  } catch {
    return false
  }
}

export async function runTurnReminders(): Promise<void> {
  if (!isWhatsAppTurnosEnabled()) return

  const now = Date.now()
  const turnsCol = await getTurnsCollection()

  // Turnos próximos aún sin recordatorio ni entrada marcada
  const candidates = (await turnsCol
    .find({
      estado: { $in: ['pendiente', 'asignado', 'confirmado'] },
      assignedToUserId: { $exists: true, $ne: '' },
      reminderSentAt: { $exists: false },
      'attendance.checkIn': null,
      fecha: { $gte: shiftDate(-1), $lte: shiftDate(1) },
    } as any)
    .project({ _id: 0 })
    .toArray()) as unknown as Turn[]

  if (candidates.length === 0) return

  const companyIds = [...new Set(candidates.map((t) => t.companyId))]
  const userIds = [...new Set(candidates.map((t) => t.assignedToUserId).filter(Boolean) as string[])]
  const locationIds = [...new Set(candidates.map((t) => t.locationId).filter(Boolean) as string[])]

  const [companiesCol, usersCol, locationsCol] = await Promise.all([
    getCompaniesCollection(), getUsersCollection(), getLocationsCollection(),
  ])
  const [companies, users, locations] = await Promise.all([
    companiesCol.find({ id: { $in: companyIds } } as any).project({ _id: 0 }).toArray() as unknown as Promise<Company[]>,
    usersCol.find({ id: { $in: userIds } } as any).project({ _id: 0, id: 1, nombreCompleto: 1, cargo: 1, telefono: 1 }).toArray() as unknown as Promise<User[]>,
    locationIds.length
      ? (locationsCol.find({ id: { $in: locationIds } } as any).project({ _id: 0 }).toArray() as unknown as Promise<Location[]>)
      : Promise.resolve([] as Location[]),
  ])
  const companyById = new Map(companies.map((c) => [c.id, c]))
  const userById = new Map(users.map((u) => [u.id, u]))
  const locationById = new Map(locations.map((l) => [l.id, l]))

  const enabledCache = new Map<string, boolean>()
  let sent = 0

  for (const turn of candidates) {
    if (sent >= MAX_PER_RUN) break

    const company = companyById.get(turn.companyId)
    if (!company) continue

    if (!enabledCache.has(turn.companyId)) enabledCache.set(turn.companyId, await isReminderEnabled(turn.companyId))
    if (!enabledCache.get(turn.companyId)) continue

    const settings = company.settings
    const timezone = settings?.timezone || DEFAULT_TIMEZONE
    const minutesBefore = settings?.recordatorioMinutosAntes ?? DEFAULT_MINUTES_BEFORE

    const startMs = zonedTimeToMs(turn.fecha, turn.hora, timezone)
    if (Number.isNaN(startMs)) continue
    // Ventana: desde (inicio - N min) hasta el inicio
    if (now < startMs - minutesBefore * 60_000 || now >= startMs) continue

    const worker = userById.get(turn.assignedToUserId ?? '')
    if (!worker?.telefono) continue

    // La sesión de WhatsApp es por usuario: se prueba con quien creó el turno
    // y, si no está abierta, con la sesión a nivel empresa.
    const candidatesUsers = [turn.creadoPorUserId, undefined]
    const senderUserId = candidatesUsers.find((u) => getStatus(turn.companyId, u).status === 'open')
    if (senderUserId === undefined && getStatus(turn.companyId, undefined).status !== 'open') continue

    const location = turn.locationId ? locationById.get(turn.locationId) : undefined
    const mapa = location?.latitud && location?.longitud
      ? `https://maps.google.com/?q=${location.latitud},${location.longitud}`
      : (location?.direccion ?? '')
    const vars = {
      nombre: worker.nombreCompleto,
      cargo: worker.cargo,
      fecha: turn.fecha,
      hora: turn.horaFin ? `${turn.hora} - ${turn.horaFin}` : turn.hora,
      ubicacion: turn.locationNombre ?? location?.nombre ?? '',
      mapa,
    }

    try {
      const result = await sendTemplate(turn.companyId, 'turno_recordatorio', worker.telefono, vars, undefined, senderUserId)
      if (result.sent) {
        await turnsCol.updateOne({ id: turn.id } as any, { $set: { reminderSentAt: new Date().toISOString() } } as any)
        sent++
        await sleep(DELAY_BETWEEN_MESSAGES_MS)
      }
    } catch (err) {
      console.warn(`[recordatorios] No se pudo enviar el turno ${turn.id}:`, err instanceof Error ? err.message : err)
    }
  }

  if (sent > 0) console.log(`[recordatorios] ${sent} recordatorio(s) de turno enviado(s).`)
}
