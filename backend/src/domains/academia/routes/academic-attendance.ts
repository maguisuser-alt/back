import { Router } from 'express'
import { resolveCompanyIdForUser, requireCompanyType } from '../lib/access.js'
import {
  calcularMinutosTardanza,
  createAsistenciaAlerta,
  createFaceVerificationLog,
  createInstructorAttendance,
  createJustificacion,
  createStudentAttendance,
  readDatabase,
  updateInstructorAttendance,
  updateJustificacion,
  updateStudentAttendance,
  updateUser,
  updateUserLocal,
  upsertInstructorAttendance,
  upsertStudentAttendance,
  validarQrTokenSesion,
} from '../lib/database.js'
import { registerFace, verifyFace } from '../lib/face-recognition.js'
import { checkWithinLocation, todayInTimezone } from '../lib/geo.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { readLocalUser } from '../lib/database.js'
import type {
  AsistenciaAlerta,
  AsistenciaEstado,
  EnhancedFaceProfile,
  IngresoValidacion,
  Justificacion,
  LivenessChallenge,
} from '../types.js'

export const academicAttendanceRouter = Router()
academicAttendanceRouter.use(requireAuth)
academicAttendanceRouter.use(requireCompanyType('academia'))

const adminOrDocente = requireRole(['admin', 'docente'])
const adminOrSupervisor = requireRole(['admin', 'supervisor'])

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function calcularEstadoAsistenciaPorTardanza(minutosTardanza: number, maxTardanzaSinFalta = 0): AsistenciaEstado {
  if (minutosTardanza === 0) return 'presente'
  if (maxTardanzaSinFalta > 0 && minutosTardanza <= maxTardanzaSinFalta) return 'tardanza'
  return 'tardanza'
}

async function generarAlertaFaltasConsecutivas(
  db: Awaited<ReturnType<typeof readDatabase>>,
  companyId: string,
  usuarioAfectadoId: string,
  tipo: 'estudiante' | 'docente',
  alertaFaltasConsecutivas: number,
) {
  const attendances = (tipo === 'estudiante' ? db.studentAttendances : db.instructorAttendances)
    .filter((a) => (a as any).companyId === companyId && (tipo === 'estudiante' ? (a as any).estudianteUserId : (a as any).docenteUserId) === usuarioAfectadoId)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))

  let faltasConsecutivas = 0
  for (const a of attendances) {
    if ((a as any).estado === 'ausente') faltasConsecutivas++
    else break
  }

  if (faltasConsecutivas >= alertaFaltasConsecutivas) {
    const u = db.users.find((x) => x.id === usuarioAfectadoId)
    await createAsistenciaAlerta({
      companyId,
      tipo: 'faltas_consecutivas',
      nivel: faltasConsecutivas >= alertaFaltasConsecutivas + 2 ? 'critical' : 'warning',
      usuarioAfectadoId,
      usuarioAfectadoNombre: u?.nombreCompleto ?? '',
      usuarioAfectadoRole: tipo,
      mensaje: `${u?.nombreCompleto ?? 'Usuario'} tiene ${faltasConsecutivas} faltas consecutivas.`,
      detalles: { faltasConsecutivas, alertaFaltasConsecutivas },
      leida: false,
      createdAt: new Date().toISOString(),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INGRESO DE ESTUDIANTE — por QR, biométrico facial o manual
// ─────────────────────────────────────────────────────────────────────────────

/** POST /academic-attendance/student/ingreso-qr — Estudiante escanea QR de la sesión */
academicAttendanceRouter.post('/student/ingreso-qr', async (req, res) => {
  const { qrToken, latitude, longitude, photoBase64 } = req.body ?? {}
  if (!qrToken) return res.status(400).json({ message: 'QR token es requerido.' })

  const decoded = validarQrTokenSesion(String(qrToken))
  if (!decoded) return res.status(400).json({ message: 'QR inválido o expirado. Pide al docente regenerar el QR.' })

  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  if (user.role !== 'estudiante' && user.role !== 'admin' && user.role !== 'docente') {
    return res.status(403).json({ message: 'Solo estudiantes pueden registrar ingreso por QR.' })
  }
  const companyId = user.companyId || req.authUser!.companyId
  if (decoded.companyId !== companyId) return res.status(403).json({ message: 'Este QR no pertenece a tu institución.' })

  const session = db.classSessions.find((s) => s.id === decoded.sessionId && s.companyId === companyId)
  if (!session) return res.status(404).json({ message: 'Sesión de clase no encontrada.' })
  if (session.estado === 'cancelada' || session.estado === 'finalizada') {
    return res.status(409).json({ message: 'La sesión no está disponible para registro.' })
  }

  const grupo = db.academicGroups.find((g) => g.id === session.academicGroupId)
  if (!grupo || (user.role === 'estudiante' && !grupo.estudianteUserIds.includes(user.id))) {
    return res.status(403).json({ message: 'No perteneces a este grupo académico.' })
  }

  const company = db.companies.find((c) => c.id === companyId)
  const tolerancia = session.toleranciaIngresoMin ?? company?.settings.toleranciaIngresoMin ?? 15
  const maxTardanza = 30

  // Verificación biométrica facial si hay foto
  let validacionIngreso: IngresoValidacion = 'qr_ok'
  let confianzaRostro: number | undefined
  if (photoBase64 && company?.settings.requireBiometric) {
    const resultado = await verifyFace(user.id, String(photoBase64))
    if (!resultado.verified) {
      return res.status(403).json({
        message: 'Verificación facial falló: el rostro no coincide con el registrado.',
        code: 'FACE_MISMATCH',
        confidence: resultado.confidence,
      })
    }
    validacionIngreso = 'biometrico_ok'
    confianzaRostro = resultado.confidence
  }

  const ahora = new Date().toISOString()
  const minutosTardanza = calcularMinutosTardanza(session.horaInicio, ahora, tolerancia)
  const estadoBase = calcularEstadoAsistenciaPorTardanza(minutosTardanza, maxTardanza)

  const att = await upsertStudentAttendance(
    { sessionId: session.id, estudianteUserId: user.id },
    {
      companyId,
      sessionId: session.id,
      academicGroupId: session.academicGroupId,
      subjectId: session.subjectId,
      fecha: session.fecha,
      estudianteUserId: user.id,
      estudianteNombre: user.nombreCompleto,
      estado: estadoBase,
      horaIngreso: ahora,
      metodo: photoBase64 ? 'biometrico_facial' : 'qr',
      validacionIngreso,
      minutosTardanza,
      observaciones: confianzaRostro !== undefined ? `Confianza facial: ${confianzaRostro}%` : undefined,
      createdAt: ahora,
      updatedAt: ahora,
    },
  )

  res.json({
    success: true,
    attendance: att,
    session: { id: session.id, nombre: session.academicGroupNombre, fecha: session.fecha, horaInicio: session.horaInicio },
    minutosTardanza,
    validacionIngreso,
  })
})

/** POST /academic-attendance/student/ingreso-biometrico — Ingreso con rostro (sin QR, busca sesión activa) */
academicAttendanceRouter.post('/student/ingreso-biometrico', async (req, res) => {
  const { imageBase64, latitude, longitude, sessionId } = req.body ?? {}
  if (!imageBase64) return res.status(400).json({ message: 'Captura facial es requerida.' })

  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  if (user.role !== 'estudiante') return res.status(403).json({ message: 'Rol no permitido.' })
  const companyId = user.companyId || req.authUser!.companyId

  // Verificar rostro
  const resultado = await verifyFace(user.id, String(imageBase64))
  if (!resultado.verified) {
    return res.status(403).json({
      message: 'Rostro no coincide con el registrado.',
      confidence: resultado.confidence,
    })
  }

  // Registrar log biométrico
  await createFaceVerificationLog({
    verified: resultado.verified,
    confidence: resultado.confidence,
    distance: resultado.distance,
    method: 'ingreso_clase',
    createdAt: new Date().toISOString(),
  })

  // Buscar sesión activa de hoy para los grupos del estudiante (fecha en zona horaria de la academia)
  const tzCompanyBio = db.companies.find((c) => c.id === companyId)
  const hoy = todayInTimezone(tzCompanyBio?.settings.timezone)
  const misGrupos = db.academicGroups.filter((g) => g.companyId === companyId && g.estudianteUserIds.includes(user.id)).map((g) => g.id)
  // Solo clases activas (programada/en_curso): no se marca ingreso en finalizadas ni canceladas.
  const sesionesHoy = db.classSessions
    .filter((s) => s.companyId === companyId && s.fecha === hoy && misGrupos.includes(s.academicGroupId)
      && (s.estado === 'programada' || s.estado === 'en_curso'))
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))

  // Si el cliente indica la sesión que eligió, usarla (respeta la clase virtual
  // concreta). Si no, caer a la primera clase del día.
  const session = sessionId
    ? sesionesHoy.find((s) => s.id === sessionId)
    : sesionesHoy[0]

  if (!session) {
    return res.status(404).json({ message: 'No tienes clases activas para hoy. No puedes marcar ingreso.' })
  }

  // ── Validación de sede: debe estar dentro del radio (se omite si la clase es virtual) ──
  if (session.ubicacionId && !session.esVirtual) {
    const sede = db.locations.find((l) => l.id === session.ubicacionId && l.companyId === companyId)
    if (sede && (sede.latitud && sede.longitud)) {
      const lat = typeof latitude === 'number' ? latitude : Number(latitude)
      const lon = typeof longitude === 'number' ? longitude : Number(longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ message: 'Debes compartir tu ubicación para marcar ingreso en la sede.' })
      }
      const check = checkWithinLocation(sede, lat, lon)
      if (check && !check.withinRange) {
        return res.status(403).json({
          message: `Estás fuera de la sede "${sede.nombre}". Debes estar a menos de ${check.allowedRadiusMeters} m (estás a ${check.distanceMeters} m).`,
          code: 'FUERA_DE_SEDE',
          distanceMeters: check.distanceMeters,
          allowedRadiusMeters: check.allowedRadiusMeters,
        })
      }
    }
  }

  const company = db.companies.find((c) => c.id === companyId)
  const tolerancia = session.toleranciaIngresoMin ?? company?.settings.toleranciaIngresoMin ?? 15
  const ahora = new Date().toISOString()
  const minutosTardanza = calcularMinutosTardanza(session.horaInicio, ahora, tolerancia)
  const estadoBase = calcularEstadoAsistenciaPorTardanza(minutosTardanza, 30)

  const att = await upsertStudentAttendance(
    { sessionId: session.id, estudianteUserId: user.id },
    {
      companyId,
      sessionId: session.id,
      academicGroupId: session.academicGroupId,
      subjectId: session.subjectId,
      fecha: session.fecha,
      estudianteUserId: user.id,
      estudianteNombre: user.nombreCompleto,
      estado: estadoBase,
      horaIngreso: ahora,
      metodo: 'biometrico_facial',
      validacionIngreso: 'biometrico_ok',
      minutosTardanza,
      createdAt: ahora,
      updatedAt: ahora,
    },
  )

  res.json({
    success: true,
    attendance: att,
    session: { id: session.id, nombre: session.academicGroupNombre, subject: session.subjectNombre },
    minutosTardanza,
    confidence: resultado.confidence,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ASISTENCIA DOCENTE / INSTRUCTOR (confirmación de asistencia del formador)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /academic-attendance/student/my-today — sesiones de HOY del estudiante,
 * con datos de la sede (coordenadas) y si ya marcó ingreso. Para el dashboard.
 */
academicAttendanceRouter.get('/student/my-today', requireRole(['estudiante']), async (req, res) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  const companyId = user.companyId || req.authUser!.companyId
  const tzToday = db.companies.find((c) => c.id === companyId)
  const hoy = todayInTimezone(tzToday?.settings.timezone)

  const misGrupos = db.academicGroups
    .filter((g) => g.companyId === companyId && g.estudianteUserIds.includes(user.id))
    .map((g) => g.id)

  const sesiones = db.classSessions
    .filter((s) => s.companyId === companyId && s.fecha === hoy && misGrupos.includes(s.academicGroupId) && s.estado !== 'cancelada')
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))
    .map((s) => {
      const sede = s.ubicacionId ? db.locations.find((l) => l.id === s.ubicacionId) : undefined
      const att = db.studentAttendances.find((a) => a.sessionId === s.id && a.estudianteUserId === user.id)
      return {
        id: s.id,
        subjectNombre: s.subjectNombre,
        academicGroupNombre: s.academicGroupNombre,
        docenteNombre: s.docenteNombre,
        fecha: s.fecha,
        horaInicio: s.horaInicio,
        horaFin: s.horaFin,
        estado: s.estado,
        esVirtual: Boolean(s.esVirtual),
        sede: sede ? {
          id: sede.id, nombre: sede.nombre, direccion: sede.direccion,
          latitud: sede.latitud, longitud: sede.longitud, radioTolerancia: sede.radioTolerancia,
        } : null,
        yaMarcoIngreso: Boolean(att?.horaIngreso),
        miEstado: att?.estado ?? null,
      }
    })

  res.json({ fecha: hoy, total: sesiones.length, sesiones })
})

/** GET /academic-attendance/instructor/my-sessions-hoy — Sesiones de hoy del docente autenticado */
academicAttendanceRouter.get('/instructor/my-sessions-hoy', requireRole(['docente']), async (req, res) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = user?.companyId || req.authUser!.companyId
  const tzInst = db.companies.find((c) => c.id === companyId)
  const hoy = todayInTimezone(tzInst?.settings.timezone)
  const sessions = db.classSessions
    .filter((s) => s.companyId === companyId && s.docenteUserId === user?.id && s.fecha === hoy)
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))

  const result = await Promise.all(sessions.map(async (s) => {
    const att = db.instructorAttendances.find((a) => a.sessionId === s.id)
    const estudiantes = db.studentAttendances.filter((a) => a.sessionId === s.id)
    return { session: s, instructorAttendance: att ?? null, estudianteCount: estudiantes.length }
  }))
  res.json(result)
})

/** POST /academic-attendance/instructor/confirmar — Docente confirma su propia asistencia a la sesión */
academicAttendanceRouter.post('/instructor/confirmar', requireRole(['docente', 'admin']), async (req, res) => {
  const { sessionId, metodo, latitude, longitude, imageBase64 } = req.body ?? {}
  if (!sessionId) return res.status(400).json({ message: 'sessionId es requerido.' })

  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  const companyId = user.companyId || req.authUser!.companyId

  const session = db.classSessions.find((s) => s.id === sessionId && s.companyId === companyId)
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (user.role === 'docente' && session.docenteUserId !== user.id) {
    return res.status(403).json({ message: 'Esta sesión no te corresponde como docente.' })
  }
  if (session.estado === 'cancelada') return res.status(409).json({ message: 'Sesión cancelada.' })

  // Opcional: verificación facial del docente
  let validacion: IngresoValidacion = 'pendiente'
  let confidence: number | undefined
  if (imageBase64) {
    const r = await verifyFace(user.id, String(imageBase64))
    if (!r.verified) {
      return res.status(403).json({ message: 'Verificación facial del docente falló.', confidence: r.confidence })
    }
    validacion = 'biometrico_ok'
    confidence = r.confidence
  }

  const ahora = new Date().toISOString()
  const metodoIngreso = (metodo === 'qr' || metodo === 'biometrico_facial' || metodo === 'pin') ? metodo : 'manual'

  // Registro de asistencia docente
  const att = await upsertInstructorAttendance(
    { sessionId: session.id },
    {
      companyId,
      sessionId: session.id,
      academicGroupId: session.academicGroupId,
      subjectId: session.subjectId,
      fecha: session.fecha,
      docenteUserId: session.docenteUserId,
      docenteNombre: session.docenteNombre ?? user.nombreCompleto,
      horaLlegada: ahora,
      estado: 'presente',
      metodoIngreso,
      validacionIngreso: validacion,
      createdAt: ahora,
      updatedAt: ahora,
    },
  )

  // Marcar en la sesión que el docente asistió
  if (!session.docenteAsistencia?.marcado) {
    session.docenteAsistencia = {
      marcado: true,
      marcadoA: ahora,
      metodo: metodoIngreso === 'biometrico_facial' ? 'biometrico_facial' : metodoIngreso === 'qr' ? 'qr' : 'manual',
      horaLlegada: ahora,
    }
    session.updatedAt = ahora
    const { updateClassSession } = await import('../lib/database.js')
    await updateClassSession(session)
  }

  res.json({ success: true, attendance: att, session, confidence })
})

/**
 * PATCH /academic-attendance/instructor/:attendanceId/confirmacion-supervisor
 * Admin/supervisor confirma la asistencia del docente
 */
academicAttendanceRouter.patch('/instructor/:attendanceId/confirmacion-supervisor', adminOrSupervisor, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { horasCatedraCumplidas, estado, observaciones } = req.body ?? {}

  const att = db.instructorAttendances.find((a) => a.id === req.params.attendanceId && a.companyId === companyId)
  if (!att) return res.status(404).json({ message: 'Asistencia docente no encontrada.' })

  if (horasCatedraCumplidas !== undefined) att.horasCatedraCumplidas = Number(horasCatedraCumplidas)
  if (estado && ['presente', 'ausente', 'tardanza', 'justificado'].includes(String(estado))) att.estado = estado as any
  if (observaciones !== undefined) att.observaciones = String(observaciones)
  att.confirmadoPor = currentUser?.id
  att.confirmadoPorNombre = currentUser?.nombreCompleto
  att.confirmadoA = new Date().toISOString()
  att.validacionIngreso = 'validado'
  att.updatedAt = new Date().toISOString()

  await updateInstructorAttendance(att)
  res.json(att)
})

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMACIÓN DOCENTE DE ASISTENCIAS DE ESTUDIANTES (requerida para oficializar)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /academic-attendance/docente/confirmar-estudiantes — Docente confirma lista de asistencia */
academicAttendanceRouter.post('/docente/confirmar-estudiantes', requireRole(['docente', 'admin']), async (req, res) => {
  const { sessionId, confirmaciones } = req.body as {
    sessionId?: string
    confirmaciones?: Array<{
      estudianteUserId: string
      estado?: AsistenciaEstado
      marcarAsistencia?: boolean
      observaciones?: string
    }>
  }
  if (!sessionId || !Array.isArray(confirmaciones)) {
    return res.status(400).json({ message: 'sessionId y confirmaciones[] son requeridos.' })
  }

  const db = await readDatabase()
  const docente = db.users.find((u) => u.id === req.authUser!.userId)
  if (!docente) return res.status(404).json({ message: 'Usuario no encontrado.' })
  const companyId = docente.companyId || req.authUser!.companyId

  const session = db.classSessions.find((s) => s.id === sessionId && s.companyId === companyId)
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (docente.role === 'docente' && session.docenteUserId !== docente.id) {
    return res.status(403).json({ message: 'No eres el docente de esta sesión.' })
  }

  const grupo = db.academicGroups.find((g) => g.id === session.academicGroupId)
  const company = db.companies.find((c) => c.id === companyId)
  const alertaFaltas = company?.settings.alertaFaltasConsecutivas ?? 3

  const resultados: any[] = []
  const ahora = new Date().toISOString()

  for (const c of confirmaciones) {
    const estudiante = db.users.find((u) => u.id === c.estudianteUserId && u.companyId === companyId)
    if (!estudiante) continue
    if (grupo && !grupo.estudianteUserIds.includes(estudiante.id)) continue

    let att = db.studentAttendances.find((a) => a.sessionId === sessionId && a.estudianteUserId === estudiante.id)
    const estadoFinal: AsistenciaEstado = (c.estado && ['presente', 'ausente', 'tardanza', 'justificado', 'excusa_pendiente'].includes(c.estado))
      ? c.estado
      : (c.marcarAsistencia ? 'presente' : 'ausente')

    if (!att) {
      att = await createStudentAttendance({
        companyId,
        sessionId,
        academicGroupId: session.academicGroupId,
        subjectId: session.subjectId,
        fecha: session.fecha,
        estudianteUserId: estudiante.id,
        estudianteNombre: estudiante.nombreCompleto,
        estado: estadoFinal,
        metodo: 'manual_docente',
        confirmadoPorDocente: true,
        confirmadoPorDocenteA: ahora,
        docenteValidadorId: docente.id,
        observaciones: c.observaciones,
        createdAt: ahora,
        updatedAt: ahora,
      })
    } else {
      att.estado = estadoFinal
      att.confirmadoPorDocente = true
      att.confirmadoPorDocenteA = ahora
      att.docenteValidadorId = docente.id
      if (c.observaciones !== undefined) att.observaciones = c.observaciones
      att.updatedAt = ahora
      await updateStudentAttendance(att)
    }
    resultados.push(att)

    // Generar alerta si es ausente
    if (estadoFinal === 'ausente') {
      await generarAlertaFaltasConsecutivas(await readDatabase(), companyId, estudiante.id, 'estudiante', alertaFaltas)
    }
  }

  // Actualizar resumen de la sesión
  const todas = db.studentAttendances.filter((a) => a.sessionId === sessionId && a.companyId === companyId)
  session.asistenciaResumen = {
    totalEstudiantes: grupo?.estudianteUserIds.length ?? 0,
    presentes: todas.filter((a) => a.estado === 'presente').length,
    ausentes: todas.filter((a) => a.estado === 'ausente').length,
    tardanzas: todas.filter((a) => a.estado === 'tardanza').length,
    justificados: todas.filter((a) => a.estado === 'justificado').length,
    porcentajeConfirmado: grupo?.estudianteUserIds.length
      ? Math.round((todas.filter((a) => a.confirmadoPorDocente).length / grupo.estudianteUserIds.length) * 100)
      : 0,
  }
  session.updatedAt = ahora
  const { updateClassSession } = await import('../lib/database.js')
  await updateClassSession(session)

  res.json({ success: true, confirmados: resultados.length, resultados, session })
})

/** PATCH /academic-attendance/student/:attendanceId/validar-ingreso — Admin/supervisor valida el ingreso */
academicAttendanceRouter.patch('/student/:attendanceId/validar-ingreso', adminOrSupervisor, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { validacionIngreso, observaciones } = req.body as {
    validacionIngreso?: IngresoValidacion
    observaciones?: string
  }

  const att = db.studentAttendances.find((a) => a.id === req.params.attendanceId && a.companyId === companyId)
  if (!att) return res.status(404).json({ message: 'Asistencia de estudiante no encontrada.' })

  if (validacionIngreso && ['pendiente', 'validado', 'rechazado', 'biometrico_ok', 'qr_ok'].includes(validacionIngreso)) {
    att.validacionIngreso = validacionIngreso
  } else if (validacionIngreso) {
    return res.status(400).json({ message: 'Estado de validación no válido.' })
  }
  if (observaciones !== undefined) att.observaciones = observaciones
  att.validadoPorId = currentUser?.id
  att.validadoPorNombre = currentUser?.nombreCompleto
  att.validadoA = new Date().toISOString()
  att.updatedAt = new Date().toISOString()

  await updateStudentAttendance(att)
  res.json(att)
})

/**
 * POST /academic-attendance/validar-ingresos-masivo
 * Valida en lote los ingresos de estudiantes en una sesión (admin/supervisor)
 */
academicAttendanceRouter.post('/validar-ingresos-masivo', adminOrSupervisor, async (req, res) => {
  const { sessionId, accion, attendanceIds } = req.body as {
    sessionId?: string
    accion?: 'validar_todos' | 'rechazar_todos' | 'personalizado'
    attendanceIds?: string[]
  }
  if (!sessionId) return res.status(400).json({ message: 'sessionId es requerido.' })

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const ahora = new Date().toISOString()

  let asistencias = db.studentAttendances.filter((a) => a.sessionId === sessionId && a.companyId === companyId)
  if (accion === 'personalizado' && Array.isArray(attendanceIds)) {
    asistencias = asistencias.filter((a) => attendanceIds.includes(a.id))
  }

  const nuevoEstado: IngresoValidacion = (accion === 'rechazar_todos') ? 'rechazado' : 'validado'
  const actualizadas = await Promise.all(asistencias.map(async (a) => {
    a.validacionIngreso = nuevoEstado
    a.validadoPorId = currentUser?.id
    a.validadoPorNombre = currentUser?.nombreCompleto
    a.validadoA = ahora
    a.updatedAt = ahora
    await updateStudentAttendance(a)
    return a
  }))
  res.json({ actualizadas: actualizadas.length, registros: actualizadas })
})

// ─────────────────────────────────────────────────────────────────────────────
// JUSTIFICACIONES
// ─────────────────────────────────────────────────────────────────────────────

academicAttendanceRouter.get('/justificaciones', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { solicitanteUserId, estado } = req.query
  const role = req.authUser!.role
  let justificaciones = db.justificaciones.filter((j) => j.companyId === companyId)

  if (role === 'estudiante' || role === 'docente') {
    justificaciones = justificaciones.filter((j) => j.solicitanteUserId === currentUser?.id)
  } else if (typeof solicitanteUserId === 'string' && solicitanteUserId) {
    justificaciones = justificaciones.filter((j) => j.solicitanteUserId === solicitanteUserId)
  }
  if (typeof estado === 'string' && estado) {
    justificaciones = justificaciones.filter((j) => j.estado === estado)
  }
  res.json(justificaciones.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

academicAttendanceRouter.post('/justificaciones', async (req, res) => {
  const { tipo, motivo, fechasAfectadas, sessionIds, documentoUrl } = req.body ?? {}
  if (!tipo || !motivo || !Array.isArray(fechasAfectadas)) {
    return res.status(400).json({ message: 'tipo, motivo y fechasAfectadas[] son requeridos.' })
  }
  const tiposValidos = ['medica', 'institucional', 'personal', 'otra']
  if (!tiposValidos.includes(String(tipo))) return res.status(400).json({ message: 'Tipo de justificación no válido.' })

  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  const companyId = user.companyId || req.authUser!.companyId

  const company = db.companies.find((c) => c.id === companyId)
  if (company?.settings.requiereExcusaFormal && String(tipo) === 'medica' && !documentoUrl) {
    return res.status(400).json({ message: 'La institución requiere documento soporte para excusas médicas.' })
  }

  const j = await createJustificacion({
    companyId,
    solicitanteUserId: user.id,
    solicitanteNombre: user.nombreCompleto,
    solicitanteRole: user.role,
    tipo: tipo as any,
    motivo: String(motivo),
    fechasAfectadas,
    sessionIds: Array.isArray(sessionIds) ? sessionIds : undefined,
    documentoUrl: documentoUrl ? String(documentoUrl) : undefined,
    estado: 'pendiente',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  res.status(201).json(j)
})

academicAttendanceRouter.patch('/justificaciones/:id/revisar', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { estado, respuesta, aplicarAsistencias } = req.body as {
    estado?: 'aprobada' | 'rechazada'
    respuesta?: string
    aplicarAsistencias?: boolean
  }

  const j = db.justificaciones.find((x) => x.id === req.params.id && x.companyId === companyId) as Justificacion | undefined
  if (!j) return res.status(404).json({ message: 'Justificación no encontrada.' })
  if (estado && !['aprobada', 'rechazada'].includes(estado)) {
    return res.status(400).json({ message: 'Estado no válido (aprobada/rechazada).' })
  }
  if (estado) j.estado = estado
  if (respuesta !== undefined) j.respuesta = String(respuesta)
  j.revisadoPorId = currentUser?.id
  j.revisadoPorNombre = currentUser?.nombreCompleto
  j.revisadoA = new Date().toISOString()
  j.updatedAt = new Date().toISOString()
  await updateJustificacion(j)

  // Si aprobada y solicitado, marcar asistencias como justificadas
  if (estado === 'aprobada' && aplicarAsistencias && j.sessionIds?.length) {
    for (const sid of j.sessionIds) {
      const atts = j.solicitanteRole === 'docente'
        ? db.instructorAttendances.filter((a) => a.sessionId === sid && a.docenteUserId === j.solicitanteUserId)
        : db.studentAttendances.filter((a) => a.sessionId === sid && a.estudianteUserId === j.solicitanteUserId)
      for (const a of atts) {
        ;(a as any).estado = 'justificado'
        ;(a as any).justificacionId = j.id
        ;(a as any).updatedAt = new Date().toISOString()
        if (j.solicitanteRole === 'docente') await updateInstructorAttendance(a as any)
        else await updateStudentAttendance(a as any)
      }
    }
  }
  res.json(j)
})

// ─────────────────────────────────────────────────────────────────────────────
// ALERTAS DE ASISTENCIA
// ─────────────────────────────────────────────────────────────────────────────

academicAttendanceRouter.get('/alertas', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { tipo, leida, nivel } = req.query
  let alertas = db.asistenciaAlertas.filter((a) => a.companyId === companyId)
  if (req.authUser!.role === 'docente' || req.authUser!.role === 'estudiante') {
    alertas = alertas.filter((a) => a.usuarioAfectadoId === currentUser?.id)
  }
  if (typeof tipo === 'string' && tipo) alertas = alertas.filter((a) => a.tipo === tipo)
  if (typeof nivel === 'string' && nivel) alertas = alertas.filter((a) => a.nivel === nivel)
  if (leida !== undefined) alertas = alertas.filter((a) => a.leida === (leida === 'true'))
  res.json(alertas.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

academicAttendanceRouter.patch('/alertas/:id', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const alerta = db.asistenciaAlertas.find((a) => a.id === req.params.id && a.companyId === companyId) as AsistenciaAlerta | undefined
  if (!alerta) return res.status(404).json({ message: 'Alerta no encontrada.' })

  const { leida, resuelta } = req.body ?? {}
  if (leida !== undefined) {
    alerta.leida = Boolean(leida)
    alerta.leidaPor = currentUser?.id
    alerta.leidaA = new Date().toISOString()
  }
  if (resuelta !== undefined) {
    alerta.resuelta = Boolean(resuelta)
    alerta.resueltaPor = currentUser?.id
    alerta.resueltaA = new Date().toISOString()
  }
  const { updateAsistenciaAlerta } = await import('../lib/database.js')
  await updateAsistenciaAlerta(alerta)
  res.json(alerta)
})

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO BIOMÉTRICO FACIAL MEJORADO — multi-foto + perfil mejorado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /academic-attendance/face/register-enhanced
 * Registra múltiples descriptores faciales (distintos ángulos) y crea EnhancedFaceProfile
 */
academicAttendanceRouter.post('/face/register-enhanced', async (req, res) => {
  const user = await readLocalUser(req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })

  const { fotos, livenessChallenges } = req.body as {
    fotos?: Array<{
      imageBase64: string
      angulo?: 'frente' | 'perfil_izq' | 'perfil_der' | 'arriba' | 'abajo'
      descriptor?: number[]
    }>
    livenessChallenges?: LivenessChallenge[]
  }
  if (!Array.isArray(fotos) || fotos.length === 0) {
    return res.status(400).json({ message: 'Se requiere al menos una foto para registro.' })
  }

  const ahora = new Date().toISOString()
  const livenessPassed = Array.isArray(livenessChallenges) && livenessChallenges.length > 0
    ? livenessChallenges.every((c) => c.requerido === false || (c as any).detectado === true)
    : undefined

  // Construir descriptores: si el cliente envía descriptor lo usamos, si no intentamos registrar con el servicio
  const descriptores = await Promise.all(fotos.map(async (f, idx) => {
    if (f.descriptor && Array.isArray(f.descriptor) && f.descriptor.length === 128) {
      return { descriptor: f.descriptor, registeredAt: ahora, angulo: f.angulo ?? (idx === 0 ? 'frente' : undefined) }
    }
    if (f.imageBase64) {
      await registerFace(user.id, f.imageBase64)
    }
    return null
  }))

  const faceProfileExistente = user.faceProfile
  const nuevosDescriptores = [
    ...(faceProfileExistente?.faceDescriptors ?? []),
    ...descriptores.filter((d): d is NonNullable<typeof d> => d !== null),
  ].slice(-20) // máximo 20 descriptores

  const perfilNuevo: EnhancedFaceProfile = {
    faceDescriptors: nuevosDescriptores,
    primaryPhotoUrl: faceProfileExistente?.primaryPhotoUrl,
    registeredAt: faceProfileExistente?.registeredAt ?? ahora,
    registeredBy: faceProfileExistente?.registeredBy,
    lastVerifiedAt: faceProfileExistente?.lastVerifiedAt,
    verificationCount: faceProfileExistente?.verificationCount ?? 0,
    failedAttempts: faceProfileExistente?.failedAttempts ?? 0,
    livenessPassed: livenessPassed ?? faceProfileExistente?.livenessPassed,
    livenessLastPassedAt: livenessPassed ? ahora : faceProfileExistente?.livenessLastPassedAt,
    livenessChallenges: livenessChallenges ?? faceProfileExistente?.livenessChallenges,
    avgConfidence: faceProfileExistente?.avgConfidence,
    recentVerifications: faceProfileExistente?.recentVerifications,
    estado: faceProfileExistente?.estado ?? 'activo',
    dispositivoRegistro: faceProfileExistente?.dispositivoRegistro,
  }

  user.faceProfile = perfilNuevo
  // Mantener compatibilidad legacy con el primer descriptor
  const primerDescriptor = perfilNuevo.faceDescriptors[0]?.descriptor
  if (primerDescriptor && primerDescriptor.length === 128) {
    user.faceDescriptor = primerDescriptor
    user.faceRegisteredAt = perfilNuevo.registeredAt
  }
  user.allowFaceReRegister = false
  await updateUserLocal(user)
  await updateUser(user)

  res.json({
    success: true,
    message: `Registro facial completado. ${nuevosDescriptores.length} foto(s) almacenada(s).`,
    profile: {
      descriptorCount: perfilNuevo.faceDescriptors.length,
      livenessPassed: perfilNuevo.livenessPassed,
      verificationCount: perfilNuevo.verificationCount,
      estado: perfilNuevo.estado,
    },
  })
})

/** GET /academic-attendance/face/profile-enhanced — Devuelve el perfil biométrico mejorado */
academicAttendanceRouter.get('/face/profile-enhanced', async (req, res) => {
  const user = await readLocalUser(req.authUser!.userId)
  if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' })
  const p = user.faceProfile
  res.json({
    tienePerfil: Boolean(p),
    descriptorCount: p?.faceDescriptors.length ?? 0,
    registeredAt: p?.registeredAt ?? user.faceRegisteredAt ?? null,
    lastVerifiedAt: p?.lastVerifiedAt ?? null,
    verificationCount: p?.verificationCount ?? 0,
    failedAttempts: p?.failedAttempts ?? 0,
    livenessPassed: p?.livenessPassed ?? false,
    livenessLastPassedAt: p?.livenessLastPassedAt ?? null,
    avgConfidence: p?.avgConfidence ?? null,
    estado: p?.estado ?? (user.faceDescriptor ? 'activo' : 'sin_registrar'),
    requiereReRegistro: p?.requiereReRegistro ?? Boolean(user.allowFaceReRegister),
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REPORTES / PORCENTAJES DE ASISTENCIA
// ─────────────────────────────────────────────────────────────────────────────

academicAttendanceRouter.get('/student/:userId/porcentaje-asistencia', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = currentUser?.companyId || req.authUser!.companyId
  const { from, to, subjectId, academicGroupId } = req.query

  let atributos = db.studentAttendances.filter((a) => a.companyId === companyId && a.estudianteUserId === req.params.userId)
  if (typeof from === 'string' && from) atributos = atributos.filter((a) => a.fecha >= from)
  if (typeof to === 'string' && to) atributos = atributos.filter((a) => a.fecha <= to)
  if (typeof subjectId === 'string' && subjectId) atributos = atributos.filter((a) => a.subjectId === subjectId)
  if (typeof academicGroupId === 'string' && academicGroupId) atributos = atributos.filter((a) => a.academicGroupId === academicGroupId)

  const total = atributos.length || 1
  const presentes = atributos.filter((a) => a.estado === 'presente').length
  const tardanzas = atributos.filter((a) => a.estado === 'tardanza').length
  const justificados = atributos.filter((a) => a.estado === 'justificado').length
  const ausentes = atributos.filter((a) => a.estado === 'ausente').length
  const porcentajeAsistencia = Math.round(((presentes + tardanzas + justificados) / total) * 1000) / 10
  const porcentajeAsistenciaEstricto = Math.round((presentes / total) * 1000) / 10

  // Por materia
  const porMateria: Array<{
    subjectId: string
    subjectNombre?: string
    total: number
    porcentajeAsistencia: number
  }> = []
  const bySubject = new Map<string, typeof atributos>()
  for (const a of atributos) {
    if (!bySubject.has(a.subjectId)) bySubject.set(a.subjectId, [])
    bySubject.get(a.subjectId)!.push(a)
  }
  for (const [sid, list] of bySubject) {
    const t = list.length || 1
    const p = list.filter((a) => a.estado === 'presente' || a.estado === 'tardanza' || a.estado === 'justificado').length
    porMateria.push({
      subjectId: sid,
      subjectNombre: db.subjects.find((s) => s.id === sid)?.nombre,
      total: list.length,
      porcentajeAsistencia: Math.round((p / t) * 1000) / 10,
    })
  }

  res.json({
    userId: req.params.userId,
    from: from ?? null,
    to: to ?? null,
    totalSesiones: total,
    presentes,
    tardanzas,
    justificados,
    ausentes,
    porcentajeAsistencia,
    porcentajeAsistenciaEstricto,
    porMateria,
  })
})
