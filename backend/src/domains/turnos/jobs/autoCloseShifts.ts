/**
 * Job automático que se ejecuta periódicamente para:
 * 1. Auto-cerrar turnos sin salida marcada (30 min después de horaFin)
 * 2. Auto-rechazar turnos no confirmados antes de su deadline
 * 3. Eliminar invitaciones expiradas (más de 1 hora)
 */
import { readDatabase, registerHorasTurno, updateClassSession, updateTurn, upsertStudentAttendance } from '../lib/database.js'
import { getUserInvitationsCollection } from '../lib/mongodb.js'
import type { AttendanceRecord, Turn } from '../types.js'

const AUTO_CLOSE_GRACE_MINUTES = 120  // 2 horas después de horaFin

function buildAutoCheckOut(turn: Turn): AttendanceRecord | null {
  if (!turn.horaFin || !turn.fecha) return null

  // Calcula la hora de fin (soporta turnos nocturnos)
  const [sh, sm] = turn.hora.split(':').map(Number)
  const [eh, em] = turn.horaFin.split(':').map(Number)
  if (Number.isNaN(eh) || Number.isNaN(em)) return null

  let endMs = new Date(`${turn.fecha}T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00-05:00`).getTime()
  const startMs = new Date(`${turn.fecha}T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00-05:00`).getTime()
  if (endMs <= startMs) endMs += 24 * 3_600_000 // nocturno

  return {
    action: 'salida',
    markedAt: new Date(endMs).toISOString(),
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
      verifiedAt: new Date(endMs).toISOString(),
    },
  }
}

export async function runAutoCloseShifts() {
  const now = Date.now()
  const db = await readDatabase()
  let closedCount = 0
  let rejectedCount = 0

  for (const turn of db.turns) {
    // ── Auto-cierre: turnos en_proceso/confirmado con checkIn pero sin checkOut, 2h después de horaFin
    // Cierra con la hora de salida programada del turno (horaFin)
    if (
      (turn.estado === 'en_proceso' || turn.estado === 'confirmado') &&
      turn.attendance?.checkIn &&
      !turn.attendance?.checkOut &&
      turn.horaFin &&
      turn.fecha
    ) {
      const [eh, em] = turn.horaFin.split(':').map(Number)
      const [sh, sm] = turn.hora.split(':').map(Number)
      if (!Number.isNaN(eh) && !Number.isNaN(em)) {
        let endMs = new Date(`${turn.fecha}T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00-05:00`).getTime()
        const startMs = new Date(`${turn.fecha}T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00-05:00`).getTime()
        if (endMs <= startMs) endMs += 24 * 3_600_000

        const graceEnd = endMs + AUTO_CLOSE_GRACE_MINUTES * 60_000

        if (now >= graceEnd) {
          const autoCheckOut = buildAutoCheckOut(turn)
          if (autoCheckOut) {
            turn.attendance = { ...turn.attendance, checkOut: autoCheckOut }
            // Supervisores no necesitan aprobación
            const assignedUser = db.users.find((u) => u.id === turn.assignedToUserId)
            const isAssignedSupervisor = assignedUser?.role === 'supervisor'
              || (assignedUser?.role !== 'admin' && Boolean(assignedUser?.cargo?.toLowerCase().includes('supervisor')))
            turn.estado = (turn.confirmedAt || isAssignedSupervisor) ? 'finalizado' : 'no_aprobado'
            turn.updatedAt = new Date().toISOString()
            await updateTurn(turn)
            // Registra las horas trabajadas
            await registerHorasTurno({
              turn,
              userName: assignedUser?.nombreCompleto ?? turn.assignedToUserName ?? '',
              cargo: assignedUser?.cargo ?? '',
              locationNombre: turn.locationNombre,
            })
            closedCount++
          }
        }
      }
    }

    // ── Auto-rechazo: turnos asignados cuyo deadline ya pasó sin confirmación
    // NOTA: Deshabilitado — el empleado puede marcar entrada sin importar el deadline.
    // El deadline es solo informativo. El auto-close por horaFin sigue activo.
  }

  if (closedCount > 0 || rejectedCount > 0) {
    console.log(`[auto-close] ${closedCount} turno(s) cerrado(s) automáticamente, ${rejectedCount} rechazado(s) por vencimiento.`)
  }

  // ── Auto-finalizar clases académicas cuya hora de fin ya pasó ──
  // Las clases en estado programada/en_curso se marcan "finalizada" automáticamente
  // una vez pasada su horaFin (zona America/Bogota, UTC-5). Los alumnos del grupo
  // que no registraron ingreso quedan "ausente".
  let clasesFinalizadas = 0
  for (const session of db.classSessions) {
    if (session.estado !== 'programada' && session.estado !== 'en_curso') continue
    if (!session.fecha || !session.horaFin) continue
    const [eh, em] = session.horaFin.split(':').map(Number)
    if (Number.isNaN(eh) || Number.isNaN(em)) continue
    const endMs = new Date(`${session.fecha}T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00-05:00`).getTime()
    if (Number.isNaN(endMs) || now < endMs) continue

    session.estado = 'finalizada'
    session.updatedAt = new Date().toISOString()
    await updateClassSession(session)
    clasesFinalizadas++

    // Marcar ausentes a los alumnos del grupo sin asistencia registrada.
    const grupo = db.academicGroups.find((g) => g.id === session.academicGroupId && g.companyId === session.companyId)
    for (const uid of grupo?.estudianteUserIds ?? []) {
      const yaTiene = db.studentAttendances.some((a) => a.sessionId === session.id && a.estudianteUserId === uid)
      if (yaTiene) continue
      const alumno = db.users.find((u) => u.id === uid)
      if (!alumno) continue
      await upsertStudentAttendance(
        { sessionId: session.id, estudianteUserId: uid },
        {
          companyId: session.companyId,
          sessionId: session.id,
          academicGroupId: session.academicGroupId,
          subjectId: session.subjectId,
          fecha: session.fecha,
          estudianteUserId: uid,
          estudianteNombre: alumno.nombreCompleto,
          estado: 'ausente',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      )
    }
  }
  if (clasesFinalizadas > 0) {
    console.log(`[auto-close] ${clasesFinalizadas} clase(s) académica(s) finalizada(s) automáticamente.`)
  }

  // ── Eliminar invitaciones expiradas (pendientes que ya pasaron de 1 hora)
  try {
    const invCol = await getUserInvitationsCollection()
    const nowISO = new Date().toISOString()
    const deleteResult = await invCol.deleteMany({
      status: 'pendiente',
      expiresAt: { $lt: nowISO },
    })
    if (deleteResult.deletedCount > 0) {
      console.log(`[auto-close] ${deleteResult.deletedCount} invitación(es) expirada(s) eliminada(s).`)
    }
  } catch (err) {
    // No bloquea el job si falla la limpieza
    console.warn('[auto-close] Error limpiando invitaciones:', err)
  }
}
