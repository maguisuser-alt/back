import { Router } from 'express'
import { resolveCompanyIdForUser, requireCompanyType } from '../lib/access.js'
import { todayInTimezone } from '../lib/geo.js'
import {
  createAcademicCourse,
  createAcademicEvent,
  createAcademicGroup,
  createClassSession,
  createSubject,
  createUser,
  createUserInvitation,
  deleteAcademicCourse,
  deleteAcademicGroup,
  deleteClassSession,
  deleteSubject,
  deleteUser,
  generarQrTokenSesion,
  readDatabase,
  updateAcademicCourse,
  updateAcademicEvent,
  updateAcademicGroup,
  updateClassSession,
  updateSubject,
  updateUser,
  upsertStudentAttendance,
} from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type {
  AcademicEvent,
  AcademicGroup,
  AcademicGroupTeacher,
  ClassSession,
  HorarioFranja,
  Subject,
} from '../types.js'

export const academicRouter = Router()
academicRouter.use(requireAuth)
academicRouter.use(requireCompanyType('academia'))

const adminOrDocente = requireRole(['admin', 'docente'])
const adminOnly = requireRole(['admin'])

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECTS (Asignaturas)
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/subjects', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const { activa } = req.query
  const subjects = db.subjects.filter((s) => {
    if (s.companyId !== companyId) return false
    if (activa !== undefined && s.activa !== (activa === 'true')) return false
    return true
  })
  res.json(subjects)
})

academicRouter.get('/subjects/:id', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const subject = db.subjects.find((s) => s.id === req.params.id && s.companyId === companyId)
  if (!subject) return res.status(404).json({ message: 'Asignatura no encontrada.' })
  res.json(subject)
})

academicRouter.post('/subjects', adminOnly, async (req, res) => {
  const { codigo, nombre, descripcion, categoria, creditos, horasAcademicas } = req.body ?? {}
  if (!codigo || !nombre) return res.status(400).json({ message: 'Código y nombre son requeridos.' })

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const dup = db.subjects.find((s) => s.companyId === companyId && s.codigo === codigo)
  if (dup) return res.status(409).json({ message: 'Ya existe una asignatura con ese código.' })

  const subject = await createSubject({
    companyId,
    codigo: String(codigo),
    nombre: String(nombre),
    descripcion: descripcion ? String(descripcion) : undefined,
    categoria: categoria ? String(categoria) : undefined,
    creditos: creditos ? Number(creditos) : undefined,
    horasAcademicas: horasAcademicas ? Number(horasAcademicas) : undefined,
    activa: true,
    createdAt: new Date().toISOString(),
  })
  res.status(201).json(subject)
})

// Lista las categorías distintas de asignaturas de la academia (para filtrar docentes)
academicRouter.get('/subject-categories', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const cats = new Set<string>()
  for (const s of db.subjects) {
    if (s.companyId === companyId && s.categoria?.trim()) cats.add(s.categoria.trim())
  }
  res.json([...cats].sort())
})

academicRouter.patch('/subjects/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const subject = db.subjects.find((s) => s.id === req.params.id && s.companyId === companyId) as Subject | undefined
  if (!subject) return res.status(404).json({ message: 'Asignatura no encontrada.' })

  const { nombre, descripcion, categoria, creditos, horasAcademicas, activa, codigo } = req.body ?? {}
  if (nombre !== undefined) subject.nombre = String(nombre)
  if (codigo !== undefined) subject.codigo = String(codigo)
  if (descripcion !== undefined) subject.descripcion = descripcion ? String(descripcion) : undefined
  if (categoria !== undefined) subject.categoria = categoria ? String(categoria) : undefined
  if (creditos !== undefined) subject.creditos = creditos ? Number(creditos) : undefined
  if (horasAcademicas !== undefined) subject.horasAcademicas = horasAcademicas ? Number(horasAcademicas) : undefined
  if (activa !== undefined) subject.activa = Boolean(activa)
  await updateSubject(subject)
  res.json(subject)
})

academicRouter.delete('/subjects/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const hasGroups = db.academicGroups.some((g) => g.companyId === companyId && g.subjectId === req.params.id)
  if (hasGroups) return res.status(409).json({ message: 'No se puede eliminar: hay grupos académicos usando esta asignatura.' })
  await deleteSubject(String(req.params.id), companyId)
  res.status(204).send()
})

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC COURSES (Carreras / Programas)
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/courses', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const courses = db.academicCourses.filter((c) => c.companyId === companyId)
  res.json(courses)
})

academicRouter.post('/courses', adminOnly, async (req, res) => {
  const { codigo, nombre, descripcion, duracionMeses, nivel } = req.body ?? {}
  if (!codigo || !nombre) return res.status(400).json({ message: 'Código y nombre son requeridos.' })

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const dup = db.academicCourses.find((c) => c.companyId === companyId && c.codigo === codigo)
  if (dup) return res.status(409).json({ message: 'Ya existe un curso con ese código.' })

  const course = await createAcademicCourse({
    companyId,
    codigo: String(codigo),
    nombre: String(nombre),
    descripcion: descripcion ? String(descripcion) : undefined,
    duracionMeses: duracionMeses ? Number(duracionMeses) : undefined,
    nivel: nivel ? String(nivel) : undefined,
    activo: true,
    createdAt: new Date().toISOString(),
  })
  res.status(201).json(course)
})

academicRouter.patch('/courses/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const course = db.academicCourses.find((c) => c.id === req.params.id && c.companyId === companyId)
  if (!course) return res.status(404).json({ message: 'Curso no encontrado.' })

  const { nombre, descripcion, duracionMeses, nivel, activo, codigo } = req.body ?? {}
  if (nombre !== undefined) course.nombre = String(nombre)
  if (codigo !== undefined) course.codigo = String(codigo)
  if (descripcion !== undefined) course.descripcion = descripcion ? String(descripcion) : undefined
  if (duracionMeses !== undefined) course.duracionMeses = duracionMeses ? Number(duracionMeses) : undefined
  if (nivel !== undefined) course.nivel = nivel ? String(nivel) : undefined
  if (activo !== undefined) course.activo = Boolean(activo)
  await updateAcademicCourse(course)
  res.json(course)
})

academicRouter.delete('/courses/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const hasGroups = db.academicGroups.some((g) => g.companyId === companyId && g.courseId === req.params.id)
  if (hasGroups) return res.status(409).json({ message: 'No se puede eliminar: hay grupos usando este curso.' })
  await deleteAcademicCourse(String(req.params.id), companyId)
  res.status(204).send()
})

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC GROUPS (Grupos académicos)
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/groups', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const role = req.authUser!.role
  const userId = req.authUser!.userId
  const { docenteUserId, courseId, subjectId } = req.query

  const groups = db.academicGroups.filter((g) => {
    if (g.companyId !== companyId) return false
    // Docente solo ve sus grupos
    if (role === 'docente' && g.docenteUserId !== userId) return false
    // Estudiante solo ve grupos a los que pertenece
    if (role === 'estudiante' && !g.estudianteUserIds.includes(userId)) return false
    if (typeof docenteUserId === 'string' && docenteUserId && g.docenteUserId !== docenteUserId) return false
    if (typeof courseId === 'string' && courseId && g.courseId !== courseId) return false
    if (typeof subjectId === 'string' && subjectId && g.subjectId !== subjectId) return false
    return true
  })
  res.json(groups)
})

academicRouter.get('/groups/:id', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const group = db.academicGroups.find((g) => g.id === req.params.id && g.companyId === companyId)
  if (!group) return res.status(404).json({ message: 'Grupo no encontrado.' })
  // Enriquecer con estudiantes
  const estudiantes = db.users.filter((u) => group.estudianteUserIds.includes(u.id))
    .map((u) => ({ id: u.id, nombreCompleto: u.nombreCompleto, codigo: u.estudiante?.codigo, numeroDocumento: u.numeroDocumento }))
  const docente = db.users.find((u) => u.id === group.docenteUserId)
  res.json({ ...group, estudiantes, docenteNombreCompleto: docente?.nombreCompleto })
})

/**
 * Construye la lista de docentes asignados (con su materia + categoría) a partir
 * del body. Acepta `docentes: [{docenteUserId, subjectId}]` (nuevo, multi-docente)
 * o los campos legacy `docenteUserId` + `subjectId` (un solo docente).
 */
function buildGroupTeachers(
  db: Awaited<ReturnType<typeof readDatabase>>,
  companyId: string,
  body: Record<string, unknown>,
): { docentes: AcademicGroupTeacher[]; error?: string } {
  const raw = Array.isArray(body.docentes) && body.docentes.length > 0
    ? (body.docentes as Array<{ docenteUserId?: string; subjectId?: string }>)
    : (body.docenteUserId && body.subjectId
        ? [{ docenteUserId: String(body.docenteUserId), subjectId: String(body.subjectId) }]
        : [])

  const docentes: AcademicGroupTeacher[] = []
  for (const item of raw) {
    if (!item?.docenteUserId || !item?.subjectId) continue
    const docente = db.users.find((u) => u.id === item.docenteUserId && u.companyId === companyId && (u.role === 'docente' || u.role === 'admin'))
    if (!docente) return { docentes: [], error: `Docente no válido (${item.docenteUserId}).` }
    const subject = db.subjects.find((s) => s.id === item.subjectId && s.companyId === companyId)
    if (!subject) return { docentes: [], error: `Asignatura no válida (${item.subjectId}).` }
    // Evitar duplicados docente+materia
    if (docentes.some((d) => d.docenteUserId === docente.id && d.subjectId === subject.id)) continue
    docentes.push({
      docenteUserId: docente.id,
      docenteNombre: docente.nombreCompleto,
      subjectId: subject.id,
      subjectNombre: subject.nombre,
      categoria: subject.categoria,
    })
  }
  return { docentes }
}

/**
 * Valida un horario semanal (franjas por día). Cada franja debe referenciar un
 * docente que esté entre los `docentes` asignados al grupo y su materia.
 */
function buildGroupHorario(
  db: Awaited<ReturnType<typeof readDatabase>>,
  companyId: string,
  docentes: AcademicGroupTeacher[],
  body: Record<string, unknown>,
): HorarioFranja[] {
  if (!Array.isArray(body.horario)) return []
  const diasValidos = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
  const franjas: HorarioFranja[] = []
  for (const f of body.horario as Array<Record<string, unknown>>) {
    const dia = String(f.dia ?? '')
    if (!diasValidos.includes(dia)) continue
    if (!f.horaInicio || !f.horaFin || !f.docenteUserId || !f.subjectId) continue
    const asignado = docentes.find((d) => d.docenteUserId === f.docenteUserId && d.subjectId === f.subjectId)
    if (!asignado) continue // solo docentes/materias asignados al grupo
    // Sede de la franja (opcional)
    const sede = f.ubicacionId ? db.locations.find((l) => l.id === f.ubicacionId && l.companyId === companyId) : undefined
    franjas.push({
      dia: dia as HorarioFranja['dia'],
      horaInicio: String(f.horaInicio),
      horaFin: String(f.horaFin),
      docenteUserId: asignado.docenteUserId,
      docenteNombre: asignado.docenteNombre,
      subjectId: asignado.subjectId,
      subjectNombre: asignado.subjectNombre,
      categoria: asignado.categoria,
      ubicacionId: sede?.id,
      ubicacionNombre: sede?.nombre,
    })
  }
  return franjas
}

/**
 * Elimina las sesiones futuras aún "programada" de un grupo que YA NO corresponden
 * a ninguna franja de su horario actual (clases fantasma tras editar el horario).
 * No toca sesiones con asistencias registradas ni pasadas/finalizadas.
 */
async function pruneOrphanSessions(
  db: Awaited<ReturnType<typeof readDatabase>>,
  companyId: string,
  group: AcademicGroup,
  desdeFecha: string,
): Promise<number> {
  const diasMap: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
  const franjas = group.horario ?? []
  if (franjas.length === 0) return 0

  const sesionesGrupo = db.classSessions.filter((s) =>
    s.companyId === companyId && s.academicGroupId === group.id
    && s.estado === 'programada' && s.fecha >= desdeFecha)

  let borradas = 0
  for (const s of sesionesGrupo) {
    const diaNum = new Date(s.fecha + 'T00:00:00Z').getUTCDay()
    const coincide = franjas.some((f) =>
      diasMap[f.dia] === diaNum && f.horaInicio === s.horaInicio && f.docenteUserId === s.docenteUserId)
    if (coincide) continue
    // No borrar si tiene asistencias registradas
    const tieneAsistencia = db.studentAttendances.some((a) => a.sessionId === s.id)
      || db.instructorAttendances.some((a) => a.sessionId === s.id)
    if (tieneAsistencia) continue
    await deleteClassSession(s.id, companyId)
    borradas++
  }
  return borradas
}

/**
 * Genera (idempotente) las sesiones de clase de un grupo entre fechaInicio y fechaFin
 * a partir de su horario semanal. Reutilizado por crear/editar grupo y por bulk-generate.
 * Devuelve el número de sesiones creadas.
 */
async function generateSessionsForGroup(
  db: Awaited<ReturnType<typeof readDatabase>>,
  companyId: string,
  group: AcademicGroup,
  fechaInicio: string,
  fechaFin: string,
): Promise<number> {
  const diasMap: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 }
  const franjas: HorarioFranja[] = (group.horario && group.horario.length > 0)
    ? group.horario
    : group.diasSemana.map((dia) => ({
        dia, horaInicio: group.horaInicio, horaFin: group.horaFin,
        docenteUserId: group.docenteUserId, docenteNombre: group.docenteNombre,
        subjectId: group.subjectId, subjectNombre: group.subjectNombre,
        ubicacionId: group.ubicacionId, ubicacionNombre: group.ubicacionNombre,
      }))
  if (franjas.length === 0) return 0

  let cursor = new Date(fechaInicio + 'T00:00:00Z')
  const end = new Date(fechaFin + 'T00:00:00Z')
  let creadas = 0
  while (cursor <= end) {
    const diaNum = cursor.getUTCDay()
    const fechaISO = cursor.toISOString().slice(0, 10)
    const franjasDelDia = franjas.filter((f) => diasMap[f.dia] === diaNum)
    for (const franja of franjasDelDia) {
      const sedeId = franja.ubicacionId ?? group.ubicacionId
      const sedeNombre = franja.ubicacionNombre ?? group.ubicacionNombre
      const existing = db.classSessions.find((s) =>
        s.companyId === companyId && s.academicGroupId === group.id && s.fecha === fechaISO
        && s.horaInicio === franja.horaInicio && s.docenteUserId === franja.docenteUserId)
      if (existing) {
        // Ya existe: sincroniza sede/materia/horaFin en sesiones aún programadas
        // (no toca clases finalizadas/canceladas). Útil al editar el horario del grupo.
        if (existing.estado === 'programada') {
          const nuevaSede = sedeId !== existing.ubicacionId
          const cambio = nuevaSede || existing.subjectNombre !== franja.subjectNombre || existing.horaFin !== franja.horaFin
          if (cambio) {
            existing.ubicacionId = sedeId
            existing.ubicacionNombre = sedeNombre
            existing.subjectId = franja.subjectId
            existing.subjectNombre = franja.subjectNombre
            existing.horaFin = franja.horaFin
            existing.updatedAt = new Date().toISOString()
            await updateClassSession(existing)
          }
        }
        continue
      }
      await createClassSession({
        companyId,
        academicGroupId: group.id,
        academicGroupNombre: group.nombre,
        subjectId: franja.subjectId,
        subjectNombre: franja.subjectNombre,
        docenteUserId: franja.docenteUserId,
        docenteNombre: franja.docenteNombre,
        fecha: fechaISO,
        horaInicio: franja.horaInicio,
        horaFin: franja.horaFin,
        // Sede de la franja si la tiene; si no, la del grupo
        ubicacionId: sedeId,
        ubicacionNombre: sedeNombre,
        estado: 'programada',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      creadas++
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return creadas
}

academicRouter.post('/groups', adminOnly, async (req, res) => {
  const body = req.body ?? {}
  const { nombre, codigo, estudianteUserIds, diasSemana, horaInicio, horaFin, courseId, ubicacionId, fechaInicio, fechaFin } = body
  if (!nombre) {
    return res.status(400).json({ message: 'El nombre del grupo es requerido.' })
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const { docentes, error } = buildGroupTeachers(db, companyId, body)
  if (error) return res.status(404).json({ message: error })
  if (docentes.length === 0) return res.status(400).json({ message: 'Asigna al menos un docente con su materia.' })

  const horario = buildGroupHorario(db, companyId, docentes, body)
  // Días de la semana: de las franjas del horario, o del campo diasSemana legacy
  const diasFromHorario = [...new Set(horario.map((f) => f.dia))]
  const dias = diasFromHorario.length > 0 ? diasFromHorario : (Array.isArray(diasSemana) ? diasSemana : [])

  // Docente/materia principal (compat.) = primer docente asignado
  const principal = docentes[0]

  const course = courseId ? db.academicCourses.find((c) => c.id === courseId && c.companyId === companyId) : undefined
  const ubicacion = ubicacionId ? db.locations.find((l) => l.id === ubicacionId && l.companyId === companyId) : undefined
  const estudiantesValidos = Array.isArray(estudianteUserIds)
    ? estudianteUserIds.filter((id: string) => db.users.some((u) => u.id === id && u.companyId === companyId && u.role === 'estudiante'))
    : []

  const group = await createAcademicGroup({
    companyId,
    nombre: String(nombre),
    codigo: codigo ? String(codigo) : `GRP-${Date.now()}`,
    subjectId: principal.subjectId,
    subjectNombre: principal.subjectNombre,
    docenteUserId: principal.docenteUserId,
    docenteNombre: principal.docenteNombre,
    docentes,
    horario,
    estudianteUserIds: estudiantesValidos,
    diasSemana: dias,
    horaInicio: horaInicio ? String(horaInicio) : (horario[0]?.horaInicio ?? '07:00'),
    horaFin: horaFin ? String(horaFin) : (horario[0]?.horaFin ?? '09:00'),
    courseId: course?.id,
    courseNombre: course?.nombre,
    ubicacionId: ubicacion?.id,
    ubicacionNombre: ubicacion?.nombre,
    fechaInicio: fechaInicio ? String(fechaInicio) : undefined,
    fechaFin: fechaFin ? String(fechaFin) : undefined,
    activo: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  // Auto-generar las clases del período si el grupo tiene horario y fechas
  let sesionesCreadas = 0
  if (group.horario && group.horario.length > 0 && group.fechaInicio && group.fechaFin) {
    const freshDb = await readDatabase()
    sesionesCreadas = await generateSessionsForGroup(freshDb, companyId, group, group.fechaInicio, group.fechaFin)
  }

  res.status(201).json({ ...group, sesionesCreadas })
})

academicRouter.patch('/groups/:id', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const group = db.academicGroups.find((g) => g.id === req.params.id && g.companyId === companyId) as AcademicGroup | undefined
  if (!group) return res.status(404).json({ message: 'Grupo no encontrado.' })
  if (req.authUser!.role === 'docente' && group.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de este grupo.' })
  }

  const body = req.body ?? {}
  const fields: (keyof AcademicGroup)[] = ['nombre', 'codigo', 'horaInicio', 'horaFin', 'fechaInicio', 'fechaFin', 'diasSemana']
  for (const f of fields) if (body[f] !== undefined) (group as any)[f] = body[f]

  if (body.ubicacionId) {
    const loc = db.locations.find((l) => l.id === body.ubicacionId && l.companyId === companyId)
    if (loc) { group.ubicacionId = loc.id; group.ubicacionNombre = loc.nombre }
  }

  // Actualizar docentes asignados (multi-docente) si vienen en el body
  if (Array.isArray(body.docentes)) {
    const { docentes, error } = buildGroupTeachers(db, companyId, body)
    if (error) return res.status(404).json({ message: error })
    if (docentes.length > 0) {
      group.docentes = docentes
      // Sincroniza docente/materia principal
      group.docenteUserId = docentes[0].docenteUserId
      group.docenteNombre = docentes[0].docenteNombre
      group.subjectId = docentes[0].subjectId
      group.subjectNombre = docentes[0].subjectNombre
    }
  } else {
    // Compat.: cambiar docente/materia principal individual
    if (body.docenteUserId) {
      const d = db.users.find((u) => u.id === body.docenteUserId && u.companyId === companyId)
      if (d) { group.docenteUserId = d.id; group.docenteNombre = d.nombreCompleto }
    }
    if (body.subjectId) {
      const s = db.subjects.find((s) => s.id === body.subjectId && s.companyId === companyId)
      if (s) { group.subjectId = s.id; group.subjectNombre = s.nombre }
    }
  }

  // Actualizar horario semanal si viene en el body
  if (Array.isArray(body.horario)) {
    const docentesRef = group.docentes ?? []
    group.horario = buildGroupHorario(db, companyId, docentesRef, body)
    const diasFromHorario = [...new Set(group.horario.map((f) => f.dia))]
    if (diasFromHorario.length > 0) group.diasSemana = diasFromHorario
  }

  if (body.courseId) {
    const c = db.academicCourses.find((c) => c.id === body.courseId && c.companyId === companyId)
    if (c) { group.courseId = c.id; group.courseNombre = c.nombre }
  }
  if (Array.isArray(body.estudianteUserIds)) {
    group.estudianteUserIds = body.estudianteUserIds.filter((id: string) =>
      db.users.some((u) => u.id === id && u.companyId === companyId && u.role === 'estudiante'),
    )
  }
  if (body.activo !== undefined) group.activo = Boolean(body.activo)
  group.updatedAt = new Date().toISOString()

  await updateAcademicGroup(group)

  // Si cambió el horario/fechas, (re)generar las clases futuras del período.
  // Solo crea las que falten (no duplica ni borra las ya existentes/pasadas).
  let sesionesCreadas = 0
  let sesionesEliminadas = 0
  if ((Array.isArray(body.horario) || body.fechaInicio || body.fechaFin)
      && group.horario && group.horario.length > 0 && group.fechaInicio && group.fechaFin) {
    const freshDb = await readDatabase()
    sesionesCreadas = await generateSessionsForGroup(freshDb, companyId, group, group.fechaInicio, group.fechaFin)
    // Si se editó el horario, eliminar las clases "fantasma" futuras que ya no
    // corresponden a ninguna franja del horario actual (sin tocar las que tienen
    // asistencias ni las pasadas). "Hoy" se calcula en zona horaria de la academia.
    if (Array.isArray(body.horario)) {
      const prunedDb = await readDatabase()
      sesionesEliminadas = await pruneOrphanSessions(prunedDb, companyId, group, todayInTimezone())
    }
  }

  res.json({ ...group, sesionesCreadas, sesionesEliminadas })
})

academicRouter.delete('/groups/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const hasSessions = db.classSessions.some((s) => s.companyId === companyId && s.academicGroupId === req.params.id)
  if (hasSessions) return res.status(409).json({ message: 'No se puede eliminar: hay sesiones programadas para este grupo.' })
  await deleteAcademicGroup(String(req.params.id), companyId)
  res.status(204).send()
})

/**
 * POST /api/academic/groups/:id/invite — genera un link de invitación para que
 * los alumnos se auto-registren y queden asignados a este grupo (rol estudiante).
 * El link es reutilizable hasta que expire (30 días por defecto).
 */
academicRouter.post('/groups/:id/invite', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const group = db.academicGroups.find((g) => g.id === req.params.id && g.companyId === companyId)
  if (!group) return res.status(404).json({ message: 'Grupo no encontrado.' })
  // El docente solo puede invitar a grupos donde imparte (principal o en su lista de docentes)
  if (req.authUser!.role === 'docente') {
    const esDocenteDelGrupo = group.docenteUserId === req.authUser!.userId
      || (group.docentes ?? []).some((d) => d.docenteUserId === req.authUser!.userId)
    if (!esDocenteDelGrupo) return res.status(403).json({ message: 'No eres docente de este grupo.' })
  }

  // Reutiliza una invitación vigente del grupo si existe (evita generar muchas)
  const existente = db.userInvitations.find(
    (i) => i.companyId === companyId && i.academicGroupId === group.id
      && i.status === 'pendiente' && (!i.expiresAt || new Date(i.expiresAt) > new Date()),
  )
  if (existente) {
    res.json({ ...existente, invitePath: `/registro-integrante/${existente.token}` })
    return
  }

  const ttlDias = Number(req.body?.diasVigencia) > 0 ? Number(req.body.diasVigencia) : 30
  const invitation = await createUserInvitation({
    companyId,
    cargo: 'Estudiante',
    role: 'estudiante',
    invitedByUserId: req.authUser!.userId,
    academicGroupId: group.id,
    academicGroupNombre: group.nombre,
  }, ttlDias * 24 * 60 * 60 * 1000)

  res.status(201).json({ ...invitation, invitePath: `/registro-integrante/${invitation.token}` })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLASS SESSIONS (Sesiones de clase)
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/sessions', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const role = req.authUser!.role
  const userId = req.authUser!.userId
  const { fecha, academicGroupId, docenteUserId, estado, from, to } = req.query

  const sessions = db.classSessions.filter((s) => {
    if (s.companyId !== companyId) return false
    if (role === 'docente' && s.docenteUserId !== userId) return false
    if (role === 'estudiante') {
      const grupo = db.academicGroups.find((g) => g.id === s.academicGroupId)
      if (!grupo || !grupo.estudianteUserIds.includes(userId)) return false
    }
    if (typeof fecha === 'string' && fecha && s.fecha !== fecha) return false
    if (typeof from === 'string' && from && s.fecha < from) return false
    if (typeof to === 'string' && to && s.fecha > to) return false
    if (typeof academicGroupId === 'string' && academicGroupId && s.academicGroupId !== academicGroupId) return false
    if (typeof docenteUserId === 'string' && docenteUserId && s.docenteUserId !== docenteUserId) return false
    if (typeof estado === 'string' && estado && s.estado !== estado) return false
    return true
  }).sort((a, b) => `${a.fecha}T${a.horaInicio}`.localeCompare(`${b.fecha}T${b.horaInicio}`))

  res.json(sessions)
})

academicRouter.get('/sessions/:id', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const session = db.classSessions.find((s) => s.id === req.params.id && s.companyId === companyId)
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })

  const attendances = db.studentAttendances.filter((a) => a.sessionId === session.id)
  const instructorAtt = db.instructorAttendances.find((a) => a.sessionId === session.id)
  const grupo = db.academicGroups.find((g) => g.id === session.academicGroupId)
  const estudiantes = grupo
    ? grupo.estudianteUserIds.map((uid) => {
      const u = db.users.find((x) => x.id === uid)
      const att = attendances.find((a) => a.estudianteUserId === uid)
      return {
        userId: uid,
        nombreCompleto: u?.nombreCompleto,
        codigo: u?.estudiante?.codigo,
        asistencia: att ?? null,
      }
    })
    : []
  res.json({ ...session, attendances, instructorAttendance: instructorAtt ?? null, estudiantes })
})

academicRouter.post('/sessions', adminOrDocente, async (req, res) => {
  const body = req.body ?? {}
  const { academicGroupId, fecha, horaInicio, horaFin, tema, observaciones, ubicacionId, toleranciaIngresoMin, tipoEvento } = body
  if (!academicGroupId || !fecha || !horaInicio) {
    return res.status(400).json({ message: 'Grupo, fecha y hora de inicio son requeridos.' })
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const group = db.academicGroups.find((g) => g.id === academicGroupId && g.companyId === companyId)
  if (!group) return res.status(404).json({ message: 'Grupo académico no encontrado.' })

  if (req.authUser!.role === 'docente' && group.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de este grupo.' })
  }

  const subject = db.subjects.find((s) => s.id === group.subjectId)
  const ubicacion = ubicacionId ? db.locations.find((l) => l.id === ubicacionId && l.companyId === companyId) : undefined
  const docente = db.users.find((u) => u.id === group.docenteUserId)

  const session = await createClassSession({
    companyId,
    academicGroupId: group.id,
    academicGroupNombre: group.nombre,
    subjectId: group.subjectId,
    subjectNombre: subject?.nombre,
    docenteUserId: group.docenteUserId,
    docenteNombre: docente?.nombreCompleto,
    fecha: String(fecha),
    horaInicio: String(horaInicio),
    horaFin: horaFin ? String(horaFin) : group.horaFin,
    ubicacionId: (ubicacion ?? (group.ubicacionId ? db.locations.find((l) => l.id === group.ubicacionId) : undefined))?.id,
    ubicacionNombre: (ubicacion ?? (group.ubicacionId ? db.locations.find((l) => l.id === group.ubicacionId) : undefined))?.nombre,
    tema: tema ? String(tema) : undefined,
    observaciones: observaciones ? String(observaciones) : undefined,
    toleranciaIngresoMin: toleranciaIngresoMin ? Number(toleranciaIngresoMin) : undefined,
    tipoEvento,
    estado: 'programada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  res.status(201).json(session)
})

/** Generar sesiones en bloque a partir del horario del grupo (entre dos fechas) */
academicRouter.post('/sessions/bulk-generate', adminOrDocente, async (req, res) => {
  const { academicGroupId, fechaInicio, fechaFin, toleranciaIngresoMin } = req.body ?? {}
  if (!academicGroupId || !fechaInicio || !fechaFin) {
    return res.status(400).json({ message: 'Grupo, fechaInicio y fechaFin son requeridos.' })
  }
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const group = db.academicGroups.find((g) => g.id === academicGroupId && g.companyId === companyId)
  if (!group) return res.status(404).json({ message: 'Grupo no encontrado.' })
  if (req.authUser!.role === 'docente' && group.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de este grupo.' })
  }

  const creadas = await generateSessionsForGroup(db, companyId, group, String(fechaInicio), String(fechaFin))
  res.status(201).json({ creadas })
})

academicRouter.patch('/sessions/:id', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const session = db.classSessions.find((s) => s.id === req.params.id && s.companyId === companyId) as ClassSession | undefined
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (req.authUser!.role === 'docente' && session.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de esta sesión.' })
  }

  const body = req.body ?? {}
  const fields: (keyof ClassSession)[] = ['fecha', 'horaInicio', 'horaFin', 'tema', 'observaciones', 'toleranciaIngresoMin', 'tipoEvento', 'estado']
  for (const f of fields) if (body[f] !== undefined) (session as any)[f] = body[f]
  if (body.esVirtual !== undefined) session.esVirtual = Boolean(body.esVirtual)

  if (body.ubicacionId) {
    const loc = db.locations.find((l) => l.id === body.ubicacionId && l.companyId === companyId)
    if (loc) { session.ubicacionId = loc.id; session.ubicacionNombre = loc.nombre }
  }
  session.updatedAt = new Date().toISOString()
  await updateClassSession(session)
  res.json(session)
})

/**
 * POST /api/academic/sessions/:id/toggle-virtual — el docente marca/desmarca
 * una sesión como virtual (ese día omite la validación de ubicación).
 */
academicRouter.post('/sessions/:id/toggle-virtual', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const session = db.classSessions.find((s) => s.id === req.params.id && s.companyId === companyId) as ClassSession | undefined
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (req.authUser!.role === 'docente' && session.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de esta sesión.' })
  }
  const nuevo = req.body?.esVirtual !== undefined ? Boolean(req.body.esVirtual) : !session.esVirtual
  session.esVirtual = nuevo
  session.updatedAt = new Date().toISOString()
  await updateClassSession(session)
  res.json({ id: session.id, esVirtual: session.esVirtual })
})

/**
 * POST /api/academic/sessions/:id/estado — cambia el estado de una clase
 * (programada ↔ finalizada ↔ cancelada). Valida transiciones permitidas.
 * Al finalizar, los alumnos del grupo que no registraron ingreso quedan "ausente".
 */
academicRouter.post('/sessions/:id/estado', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const session = db.classSessions.find((s) => s.id === req.params.id && s.companyId === companyId) as ClassSession | undefined
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (req.authUser!.role === 'docente' && session.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de esta sesión.' })
  }

  const nuevo = String(req.body?.estado ?? '') as ClassSession['estado']
  const permitidos: ClassSession['estado'][] = ['programada', 'finalizada', 'cancelada']
  if (!permitidos.includes(nuevo)) {
    return res.status(400).json({ message: 'Estado inválido. Usa: programada, finalizada o cancelada.' })
  }
  // Transiciones permitidas: desde finalizada/cancelada solo se puede reabrir a "programada".
  const actual = session.estado
  const transicionesValidas: Record<string, ClassSession['estado'][]> = {
    programada: ['finalizada', 'cancelada'],
    en_curso: ['finalizada', 'cancelada', 'programada'],
    finalizada: ['programada'],
    cancelada: ['programada'],
  }
  if (actual !== nuevo && !(transicionesValidas[actual] ?? []).includes(nuevo)) {
    return res.status(409).json({ message: `No se puede pasar de "${actual}" a "${nuevo}".` })
  }

  // Cancelar solo se permite hasta 30 min antes de la hora de inicio de la clase.
  if (nuevo === 'cancelada' && session.fecha && session.horaInicio) {
    const [h, m] = session.horaInicio.split(':').map(Number)
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const inicioMs = new Date(`${session.fecha}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`).getTime()
      const limiteMs = inicioMs - 30 * 60_000
      if (Date.now() > limiteMs) {
        return res.status(409).json({ message: 'Solo puedes cancelar hasta 30 minutos antes del inicio de la clase.' })
      }
    }
  }

  session.estado = nuevo
  session.updatedAt = new Date().toISOString()
  await updateClassSession(session)

  // Al finalizar: marca ausentes a los alumnos del grupo sin ingreso registrado.
  let ausentesMarcados = 0
  if (nuevo === 'finalizada') {
    const grupo = db.academicGroups.find((g) => g.id === session.academicGroupId && g.companyId === companyId)
    const alumnos = grupo?.estudianteUserIds ?? []
    for (const uid of alumnos) {
      const yaTiene = db.studentAttendances.some((a) => a.sessionId === session.id && a.estudianteUserId === uid)
      if (yaTiene) continue
      const alumno = db.users.find((u) => u.id === uid)
      if (!alumno) continue
      await upsertStudentAttendance(
        { sessionId: session.id, estudianteUserId: uid },
        {
          companyId,
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
      ausentesMarcados++
    }
  }

  res.json({ id: session.id, estado: session.estado, ausentesMarcados })
})

/** Genera (o regenera) el QR dinámico de una sesión */
academicRouter.post('/sessions/:id/generate-qr', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const session = db.classSessions.find((s) => s.id === req.params.id && s.companyId === companyId) as ClassSession | undefined
  if (!session) return res.status(404).json({ message: 'Sesión no encontrada.' })
  if (req.authUser!.role === 'docente' && session.docenteUserId !== req.authUser!.userId) {
    return res.status(403).json({ message: 'No eres el docente de esta sesión.' })
  }
  if (session.estado === 'finalizada' || session.estado === 'cancelada') {
    return res.status(409).json({ message: 'La sesión está finalizada/cancelada.' })
  }

  const { expiracionMin } = req.body ?? {}
  const qr = generarQrTokenSesion(session.id, companyId, Number(expiracionMin) || 30)
  session.qrToken = qr.token
  session.qrPayload = qr.payload
  session.qrExpiracion = qr.expiracion
  session.qrGeneradoA = new Date().toISOString()
  session.updatedAt = new Date().toISOString()
  await updateClassSession(session)
  res.json({ token: session.qrToken, payload: session.qrPayload, expiracion: session.qrExpiracion })
})

academicRouter.delete('/sessions/:id', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const hasAttendance = db.studentAttendances.some((a) => a.sessionId === req.params.id && a.companyId === companyId)
    || db.instructorAttendances.some((a) => a.sessionId === req.params.id && a.companyId === companyId)
  if (hasAttendance) return res.status(409).json({ message: 'No se puede eliminar: ya hay asistencias registradas.' })
  await deleteClassSession(String(req.params.id), companyId)
  res.status(204).send()
})

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC EVENTS (Eventos / Talleres)
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/events', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const { from, to, estado } = req.query
  const events = db.academicEvents.filter((e) => {
    if (e.companyId !== companyId) return false
    if (typeof from === 'string' && from && e.fecha < from) return false
    if (typeof to === 'string' && to && e.fecha > to) return false
    if (typeof estado === 'string' && estado && e.estado !== estado) return false
    return true
  }).sort((a, b) => `${a.fecha}T${a.horaInicio}`.localeCompare(`${b.fecha}T${b.horaInicio}`))
  res.json(events)
})

academicRouter.post('/events', adminOrDocente, async (req, res) => {
  const body = req.body ?? {}
  const { tipo, nombre, fecha, horaInicio, horaFin, descripcion, ubicacionId, subjectId, academicGroupIds, requiereAsistencia } = body
  if (!nombre || !fecha || !horaInicio) return res.status(400).json({ message: 'Nombre, fecha y hora de inicio son requeridos.' })

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const subject = subjectId ? db.subjects.find((s) => s.id === subjectId && s.companyId === companyId) : undefined
  const ubicacion = ubicacionId ? db.locations.find((l) => l.id === ubicacionId && l.companyId === companyId) : undefined
  const groupsValidos = Array.isArray(academicGroupIds)
    ? academicGroupIds.filter((id: string) => db.academicGroups.some((g) => g.id === id && g.companyId === companyId))
    : []

  const ev: AcademicEvent = await createAcademicEvent({
    companyId,
    tipo: tipo ?? 'evento',
    nombre: String(nombre),
    fecha: String(fecha),
    horaInicio: String(horaInicio),
    horaFin: horaFin ? String(horaFin) : undefined,
    descripcion: descripcion ? String(descripcion) : undefined,
    ubicacionId: ubicacion?.id,
    ubicacionNombre: ubicacion?.nombre,
    organizadorUserId: currentUser?.id,
    organizadorNombre: currentUser?.nombreCompleto,
    subjectId: subject?.id,
    subjectNombre: subject?.nombre,
    academicGroupIds: groupsValidos,
    requiereAsistencia: Boolean(requiereAsistencia),
    estado: 'programado',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  res.status(201).json(ev)
})

academicRouter.patch('/events/:id', adminOrDocente, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const ev = db.academicEvents.find((e) => e.id === req.params.id && e.companyId === companyId) as AcademicEvent | undefined
  if (!ev) return res.status(404).json({ message: 'Evento no encontrado.' })

  const body = req.body ?? {}
  const fields: (keyof AcademicEvent)[] = ['nombre', 'tipo', 'fecha', 'horaInicio', 'horaFin', 'descripcion', 'requiereAsistencia', 'estado']
  for (const f of fields) if (body[f] !== undefined) (ev as any)[f] = body[f]

  if (body.ubicacionId) {
    const loc = db.locations.find((l) => l.id === body.ubicacionId && l.companyId === companyId)
    if (loc) { ev.ubicacionId = loc.id; ev.ubicacionNombre = loc.nombre }
  }
  ev.updatedAt = new Date().toISOString()
  await updateAcademicEvent(ev)
  res.json(ev)
})

// ─────────────────────────────────────────────────────────────────────────────
// REPORTES RÁPIDOS
// ─────────────────────────────────────────────────────────────────────────────

academicRouter.get('/dashboard-summary', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const today = new Date().toISOString().slice(0, 10)
  const hoy = db.classSessions.filter((s) => s.companyId === companyId && s.fecha === today)
  const totalEstudiantes = db.users.filter((u) => u.companyId === companyId && u.role === 'estudiante' && u.activa).length
  const totalDocentes = db.users.filter((u) => u.companyId === companyId && u.role === 'docente' && u.activa).length
  const alertasPendientes = db.asistenciaAlertas.filter((a) => a.companyId === companyId && !a.leida).length

  // % asistencia promedio (últimas 2 semanas)
  const twoWeeks = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
  const attsRecientes = db.studentAttendances.filter((a) => a.companyId === companyId && a.fecha >= twoWeeks)
  const totalAtts = attsRecientes.length || 1
  const presentes = attsRecientes.filter((a) => a.estado === 'presente' || a.estado === 'tardanza').length
  const porcentajeAsistencia = Math.round((presentes / totalAtts) * 1000) / 10

  res.json({
    totalEstudiantes,
    totalDocentes,
    totalGrupos: db.academicGroups.filter((g) => g.companyId === companyId && g.activo).length,
    totalAsignaturas: db.subjects.filter((s) => s.companyId === companyId && s.activa).length,
    sesionesHoy: hoy.length,
    alertasPendientes,
    porcentajeAsistencia,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAS (Docentes y Estudiantes) — registro directo por el admin
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/academic/people?role=docente|estudiante — lista docentes/alumnos */
academicRouter.get('/people', async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const { role, q } = req.query

  const query = typeof q === 'string' ? q.trim().toLowerCase() : ''
  const people = db.users
    .filter((u) => {
      if (u.companyId !== companyId) return false
      if (typeof role === 'string' && role && u.role !== role) return false
      if (role === undefined && !['docente', 'estudiante'].includes(u.role)) return false
      if (query) {
        const hay = `${u.nombreCompleto} ${u.numeroDocumento} ${u.correo} ${u.docente?.especialidad ?? ''} ${u.estudiante?.codigo ?? ''}`.toLowerCase()
        if (!hay.includes(query)) return false
      }
      return true
    })
    .map((u) => ({
      id: u.id,
      nombreCompleto: u.nombreCompleto,
      tipoDocumento: u.tipoDocumento,
      numeroDocumento: u.numeroDocumento,
      correo: u.correo,
      telefono: u.telefono,
      role: u.role,
      activa: u.activa,
      docente: u.docente,
      estudiante: u.estudiante,
      createdAt: u.createdAt,
    }))

  res.json(people)
})

/**
 * POST /api/academic/people — crea un docente o estudiante directamente.
 * Body: { role: 'docente'|'estudiante', nombreCompleto, tipoDocumento, numeroDocumento, correo, telefono?,
 *         docente?: { especialidad?, titulo?, codigo? }, estudiante?: { codigo?, cursoId? } }
 */
academicRouter.post('/people', adminOnly, async (req, res) => {
  const body = req.body ?? {}
  const { role, nombreCompleto, tipoDocumento, numeroDocumento, correo, telefono } = body

  if (!role || !['docente', 'estudiante'].includes(role)) {
    return res.status(400).json({ message: 'El rol debe ser "docente" o "estudiante".' })
  }
  if (!nombreCompleto || !tipoDocumento || !numeroDocumento || !correo) {
    return res.status(400).json({ message: 'Nombre, tipo/número de documento y correo son requeridos.' })
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const dup = db.users.find((u) => u.companyId === companyId && (u.correo === correo || u.numeroDocumento === numeroDocumento))
  if (dup) return res.status(409).json({ message: 'Ya existe una persona con ese correo o documento en esta institución.' })

  const cargo = role === 'docente' ? 'Docente' : 'Estudiante'
  const extra: Record<string, unknown> = {}
  if (role === 'docente' && body.docente) {
    extra.docente = {
      codigo: body.docente.codigo ? String(body.docente.codigo) : undefined,
      titulo: body.docente.titulo ? String(body.docente.titulo) : undefined,
      especialidad: body.docente.especialidad ? String(body.docente.especialidad) : undefined,
    }
  }
  if (role === 'estudiante' && body.estudiante) {
    extra.estudiante = {
      codigo: body.estudiante.codigo ? String(body.estudiante.codigo) : undefined,
      cursoId: body.estudiante.cursoId ? String(body.estudiante.cursoId) : undefined,
      fechaIngreso: new Date().toISOString(),
    }
  }

  const user = await createUser({
    companyId,
    nombreCompleto: String(nombreCompleto),
    tipoDocumento: String(tipoDocumento),
    numeroDocumento: String(numeroDocumento),
    correo: String(correo),
    telefono: telefono ? String(telefono) : undefined,
    cargo,
    role,
    activa: true,
    createdAt: new Date().toISOString(),
    ...extra,
  })

  res.status(201).json(user)
})

/** PATCH /api/academic/people/:userId — edita datos de un docente/estudiante */
academicRouter.patch('/people/:userId', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const user = db.users.find((u) => u.id === req.params.userId && u.companyId === companyId)
  if (!user) return res.status(404).json({ message: 'Persona no encontrada.' })
  if (!['docente', 'estudiante'].includes(user.role)) {
    return res.status(400).json({ message: 'Solo se pueden editar docentes o estudiantes.' })
  }

  const body = req.body ?? {}
  if (body.nombreCompleto !== undefined) user.nombreCompleto = String(body.nombreCompleto)
  if (body.tipoDocumento !== undefined) user.tipoDocumento = String(body.tipoDocumento)
  if (body.numeroDocumento !== undefined) user.numeroDocumento = String(body.numeroDocumento)
  if (body.correo !== undefined) user.correo = String(body.correo)
  if (body.telefono !== undefined) user.telefono = body.telefono ? String(body.telefono) : undefined
  if (body.activa !== undefined) user.activa = Boolean(body.activa)
  if (user.role === 'docente' && body.docente) {
    user.docente = { ...(user.docente ?? {}), ...body.docente }
  }
  if (user.role === 'estudiante' && body.estudiante) {
    user.estudiante = { ...(user.estudiante ?? {}), ...body.estudiante }
  }

  await updateUser(user)
  res.json(user)
})

/** DELETE /api/academic/people/:userId — elimina un docente/estudiante */
academicRouter.delete('/people/:userId', adminOnly, async (req, res) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const user = db.users.find((u) => u.id === req.params.userId && u.companyId === companyId)
  if (!user) return res.status(404).json({ message: 'Persona no encontrada.' })
  if (user.id === req.authUser!.userId) return res.status(403).json({ message: 'No puedes eliminar tu propia cuenta.' })

  // Si es docente con grupos activos, bloquear
  if (user.role === 'docente' && db.academicGroups.some((g) => g.companyId === companyId && g.docenteUserId === user.id)) {
    return res.status(409).json({ message: 'No se puede eliminar: el docente tiene grupos asignados.' })
  }

  await deleteUser(user.id, companyId)
  res.status(204).send()
})

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICACIONES (clases próximas + alertas) — para docentes y estudiantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/academic/notifications
 * Devuelve notificaciones del usuario según su rol:
 *  - Próximas clases (hoy y siguientes 7 días).
 *  - Clases de hoy pendientes de confirmar (docentes).
 *  - Alertas de inasistencia dirigidas al usuario (o generales para admin).
 */
academicRouter.get('/notifications', async (req, res) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === req.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, user)
  const role = req.authUser!.role
  const userId = req.authUser!.userId

  const tzNotif = db.companies.find((c) => c.id === companyId)
  const hoy = todayInTimezone(tzNotif?.settings.timezone)
  // "en 7 días" calculado a partir de hoy local
  const en7 = (() => { const [y, m, d] = hoy.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + 7)); return dt.toISOString().slice(0, 10) })()

  // Sesiones visibles para el usuario según rol
  const visibles = db.classSessions.filter((s) => {
    if (s.companyId !== companyId) return false
    if (role === 'docente' && s.docenteUserId !== userId) return false
    if (role === 'estudiante') {
      const g = db.academicGroups.find((x) => x.id === s.academicGroupId)
      if (!g || !g.estudianteUserIds.includes(userId)) return false
    }
    return true
  })

  const notifications: Array<{
    id: string
    tipo: 'clase_hoy' | 'clase_proxima' | 'por_confirmar' | 'alerta'
    nivel: 'info' | 'warning' | 'critical'
    titulo: string
    detalle: string
    fecha?: string
    hora?: string
    sessionId?: string
    createdAt: string
  }> = []

  for (const s of visibles) {
    if (s.fecha === hoy && (s.estado === 'programada' || s.estado === 'en_curso')) {
      notifications.push({
        id: `clase-hoy-${s.id}`,
        tipo: 'clase_hoy', nivel: 'info',
        titulo: `Clase hoy: ${s.subjectNombre ?? ''}`,
        detalle: `${s.academicGroupNombre ?? ''} · ${s.horaInicio}${s.horaFin ? `–${s.horaFin}` : ''}${role !== 'docente' ? ` · ${s.docenteNombre ?? ''}` : ''}`,
        fecha: s.fecha, hora: s.horaInicio, sessionId: s.id,
        createdAt: s.createdAt,
      })
      // Docente: pendiente de confirmar asistencia
      if (role === 'docente' && !s.asistenciaResumen?.porcentajeConfirmado) {
        notifications.push({
          id: `confirmar-${s.id}`,
          tipo: 'por_confirmar', nivel: 'warning',
          titulo: `Confirma asistencia: ${s.subjectNombre ?? ''}`,
          detalle: `${s.academicGroupNombre ?? ''} · ${s.horaInicio}`,
          fecha: s.fecha, hora: s.horaInicio, sessionId: s.id,
          createdAt: s.createdAt,
        })
      }
    } else if (s.fecha > hoy && s.fecha <= en7 && s.estado === 'programada') {
      notifications.push({
        id: `clase-prox-${s.id}`,
        tipo: 'clase_proxima', nivel: 'info',
        titulo: `Próxima clase: ${s.subjectNombre ?? ''}`,
        detalle: `${s.fecha} · ${s.horaInicio}${s.horaFin ? `–${s.horaFin}` : ''} · ${s.academicGroupNombre ?? ''}`,
        fecha: s.fecha, hora: s.horaInicio, sessionId: s.id,
        createdAt: s.createdAt,
      })
    }
  }

  // Alertas de inasistencia
  const alertas = db.asistenciaAlertas.filter((a) => {
    if (a.companyId !== companyId) return false
    if (role === 'admin' || role === 'supervisor') return !a.leida
    return a.usuarioAfectadoId === userId && !a.leida
  })
  for (const a of alertas) {
    notifications.push({
      id: `alerta-${a.id}`,
      tipo: 'alerta',
      nivel: a.nivel === 'critical' ? 'critical' : 'warning',
      titulo: 'Alerta de inasistencia',
      detalle: a.mensaje,
      createdAt: a.createdAt,
    })
  }

  // Orden: por fecha/hora ascendente para clases, alertas al final
  notifications.sort((x, y) => {
    const kx = x.fecha ? `${x.fecha}T${x.hora ?? ''}` : `9999`
    const ky = y.fecha ? `${y.fecha}T${y.hora ?? ''}` : `9999`
    return kx.localeCompare(ky)
  })

  res.json({ total: notifications.length, notifications })
})
