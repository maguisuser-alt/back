/**
 * Job automático que se ejecuta periódicamente para:
 * 1. Auto-cerrar turnos sin salida marcada (gracia configurable tras horaFin)
 * 2. Auto-finalizar clases académicas vencidas
 * 3. Eliminar invitaciones expiradas (más de 1 hora)
 *
 * Usa consultas filtradas (no carga toda la base) para ahorrar RAM en el plan gratis.
 */
import { registerHorasTurno, updateClassSession, updateTurn, upsertStudentAttendance } from '../lib/database.js'
import { zonedTimeToMs } from '../lib/geo.js'
import {
  getAcademicGroupsCollection,
  getClassSessionsCollection,
  getCompaniesCollection,
  getStudentAttendancesCollection,
  getTurnsCollection,
  getUserInvitationsCollection,
  getUsersCollection,
} from '../lib/mongodb.js'
import type { AttendanceRecord, ClassSession, Company, Turn, User } from '../types.js'

const DEFAULT_GRACE_MINUTES = 120  // 2 horas después de horaFin
const DEFAULT_TIMEZONE = 'America/Bogota'

/** Inicio y fin (ms UTC) de un turno en la zona horaria dada; soporta turnos nocturnos. */
function turnRangeMs(turn: Turn, timezone: string): { startMs: number; endMs: number } | null {
  if (!turn.horaFin || !turn.fecha || !turn.hora) return null
  const [eh, em] = turn.horaFin.split(':').map(Number)
  if (Number.isNaN(eh) || Number.isNaN(em)) return null
  const startMs = zonedTimeToMs(turn.fecha, turn.hora, timezone)
  let endMs = zonedTimeToMs(turn.fecha, turn.horaFin, timezone)
  if (endMs <= startMs) endMs += 24 * 3_600_000 // nocturno
  return { startMs, endMs }
}

function buildAutoCheckOut(turn: Turn, endMs: number): AttendanceRecord {
  const iso = new Date(endMs).toISOString()
  return {
    action: 'salida',
    markedAt: iso,
    method: 'auto',
    credentialId: 'system',
    locationCheck: {
      latitude: 0,
      longitude: 0,
      distanceMeters: 0,
      allowedRadiusMeters: 0,
      withinRange: true,
      locationId: turn.locationId ?? '',
      locationNombre: turn.locationNombre,
      verifiedAt: iso,
    },
  }
}

export async function runAutoCloseShifts() {
  const now = Date.now()
  let closedCount = 0

  const [turnsCol, usersCol, companiesCol] = await Promise.all([
    getTurnsCollection(), getUsersCollection(), getCompaniesCollection(),
  ])

  // ── Auto-cierre: solo turnos abiertos (con checkIn y sin checkOut) ──
  const openTurns = (await turnsCol
    .find({
      estado: { $in: ['en_proceso', 'confirmado'] },
      'attendance.checkIn': { $exists: true, $ne: null },
      'attendance.checkOut': null, // null también coincide con campo ausente
      horaFin: { $exists: true, $ne: '' },
    } as any)
    .project({ _id: 0 })
    .toArray()) as unknown as Turn[]

  if (openTurns.length > 0) {
    const companyIds = [...new Set(openTurns.map((t) => t.companyId))]
    const userIds = [...new Set(openTurns.map((t) => t.assignedToUserId).filter(Boolean) as string[])]
    const [companies, users] = await Promise.all([
      companiesCol.find({ id: { $in: companyIds } } as any).project({ _id: 0 }).toArray() as unknown as Promise<Company[]>,
      usersCol.find({ id: { $in: userIds } } as any).project({ _id: 0 }).toArray() as unknown as Promise<User[]>,
    ])
    const companyById = new Map(companies.map((c) => [c.id, c]))
    const userById = new Map(users.map((u) => [u.id, u]))

    for (const turn of openTurns) {
      const settings = companyById.get(turn.companyId)?.settings
      const timezone = settings?.timezone || DEFAULT_TIMEZONE
      const graceMinutes = settings?.autoCloseGraceMinutes ?? DEFAULT_GRACE_MINUTES

      const range = turnRangeMs(turn, timezone)
      if (!range) continue
      if (now < range.endMs + graceMinutes * 60_000) continue

      turn.attendance = { ...turn.attendance, checkOut: buildAutoCheckOut(turn, range.endMs) }

      // Supervisores no necesitan aprobación
      const assignedUser = userById.get(turn.assignedToUserId ?? '')
      const isAssignedSupervisor = assignedUser?.role === 'supervisor'
        || (assignedUser?.role !== 'admin' && Boolean(assignedUser?.cargo?.toLowerCase().includes('supervisor')))
      turn.estado = (turn.confirmedAt || isAssignedSupervisor) ? 'finalizado' : 'no_aprobado'
      turn.updatedAt = new Date().toISOString()
      await updateTurn(turn)

      // Registra las horas trabajadas con la configuración de la empresa
      await registerHorasTurno({
        turn,
        userName: assignedUser?.nombreCompleto ?? turn.assignedToUserName ?? '',
        cargo: assignedUser?.cargo ?? '',
        locationNombre: turn.locationNombre,
        valorHora: settings?.billingRateDefault,
        recargoDominical: settings?.recargoDominical,
        recargoFestivo: settings?.recargoFestivo,
        recargoNocturno: settings?.recargoNocturno,
        jornadaOrdinaria: settings?.jornadaOrdinaria,
        nocturnoInicioHora: settings?.nocturnoInicioHora,
        nocturnoFinHora: settings?.nocturnoFinHora,
        timezone,
      })
      closedCount++
    }
  }

  if (closedCount > 0) {
    console.log(`[auto-close] ${closedCount} turno(s) cerrado(s) automáticamente.`)
  }
  // NOTA: el auto-rechazo por deadline sigue deshabilitado (el deadline es solo informativo).

  // ── Auto-finalizar clases académicas cuya hora de fin ya pasó ──
  let clasesFinalizadas = 0
  const [sessionsCol, groupsCol, attendancesCol] = await Promise.all([
    getClassSessionsCollection(), getAcademicGroupsCollection(), getStudentAttendancesCollection(),
  ])
  const pendingSessions = (await sessionsCol
    .find({ estado: { $in: ['programada', 'en_curso'] } } as any)
    .project({ _id: 0 })
    .toArray()) as unknown as ClassSession[]

  if (pendingSessions.length > 0) {
    const sessionCompanyIds = [...new Set(pendingSessions.map((s) => s.companyId))]
    const sessionCompanies = (await companiesCol
      .find({ id: { $in: sessionCompanyIds } } as any)
      .project({ _id: 0, id: 1, 'settings.timezone': 1 })
      .toArray()) as unknown as Company[]
    const tzByCompany = new Map(sessionCompanies.map((c) => [c.id, c.settings?.timezone || DEFAULT_TIMEZONE]))

    for (const session of pendingSessions) {
      if (!session.fecha || !session.horaFin) continue
      const tz = tzByCompany.get(session.companyId) ?? DEFAULT_TIMEZONE
      const endMs = zonedTimeToMs(session.fecha, session.horaFin, tz)
      if (Number.isNaN(endMs) || now < endMs) continue

      session.estado = 'finalizada'
      session.updatedAt = new Date().toISOString()
      await updateClassSession(session)
      clasesFinalizadas++

      // Marcar ausentes a los alumnos del grupo sin asistencia registrada.
      const grupo = (await groupsCol.findOne({ id: session.academicGroupId, companyId: session.companyId } as any)) as any
      const studentIds: string[] = grupo?.estudianteUserIds ?? []
      if (studentIds.length === 0) continue

      const [existing, alumnos] = await Promise.all([
        attendancesCol.find({ sessionId: session.id } as any).project({ estudianteUserId: 1 }).toArray(),
        usersCol.find({ id: { $in: studentIds } } as any).project({ _id: 0, id: 1, nombreCompleto: 1 }).toArray() as unknown as Promise<User[]>,
      ])
      const yaTienen = new Set(existing.map((a: any) => a.estudianteUserId))
      const nombreById = new Map(alumnos.map((u) => [u.id, u.nombreCompleto]))

      for (const uid of studentIds) {
        if (yaTienen.has(uid)) continue
        const nombre = nombreById.get(uid)
        if (!nombre) continue
        await upsertStudentAttendance(
          { sessionId: session.id, estudianteUserId: uid },
          {
            companyId: session.companyId,
            sessionId: session.id,
            academicGroupId: session.academicGroupId,
            subjectId: session.subjectId,
            fecha: session.fecha,
            estudianteUserId: uid,
            estudianteNombre: nombre,
            estado: 'ausente',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        )
      }
    }
  }
  if (clasesFinalizadas > 0) {
    console.log(`[auto-close] ${clasesFinalizadas} clase(s) académica(s) finalizada(s) automáticamente.`)
  }

  // ── Eliminar invitaciones expiradas (pendientes que ya pasaron de 1 hora)
  try {
    const invCol = await getUserInvitationsCollection()
    const deleteResult = await invCol.deleteMany({
      status: 'pendiente',
      expiresAt: { $lt: new Date().toISOString() },
    })
    if (deleteResult.deletedCount > 0) {
      console.log(`[auto-close] ${deleteResult.deletedCount} invitación(es) expirada(s) eliminada(s).`)
    }
  } catch (err) {
    // No bloquea el job si falla la limpieza
    console.warn('[auto-close] Error limpiando invitaciones:', err)
  }
}
