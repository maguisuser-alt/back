import { Router } from 'express'
import { resolveCompanyIdForUser } from '../lib/access.js'
import { createTurn, deleteTurn, readDatabase, updateTurn } from '../lib/database.js'
import { getHorasTurnoCollection } from '../lib/mongodb.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { TurnStatus } from '../types.js'

export const turnsRouter = Router()

/** Calcula el deadline de confirmación: hora del turno - N horas (default 4). */
function buildConfirmedDeadline(fecha: string, hora: string, hoursLimit = 4): string {
  const turnStart = new Date(`${fecha}T${hora}:00`)
  const deadline = new Date(turnStart.getTime() - hoursLimit * 60 * 60 * 1000)
  return deadline.toISOString()
}

turnsRouter.use(requireAuth)

turnsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const { fecha, estado, assignedToUserId, locationId } = request.query
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const role = request.authUser!.role
  const userId = request.authUser!.userId

  // Detecta supervisor por rol exacto O por cargo que contenga "supervisor"
  const isSupervisor = role === 'supervisor'
    || (role !== 'admin' && currentUser?.cargo?.toLowerCase().includes('supervisor'))

  const turns = db.turns.filter((turn) => {
    if (turn.companyId !== companyId) return false

    // Operativo puro (sin cargo supervisor): solo sus propios turnos
    if (!isSupervisor && role === 'operativo' && turn.assignedToUserId !== userId) return false

    // Supervisor y admin: ven todos los turnos de la empresa
    // (el frontend filtra lo que muestra según el contexto)

    if (typeof fecha === 'string' && fecha && turn.fecha !== fecha) return false
    if (typeof estado === 'string' && estado && turn.estado !== estado) return false
    if (typeof assignedToUserId === 'string' && assignedToUserId && turn.assignedToUserId !== assignedToUserId) return false
    if (typeof locationId === 'string' && locationId && turn.locationId !== locationId) return false

    return true
  })

  // Enriquece los turnos con nombre de ubicación y nombre del asignado
  const usersById = new Map(db.users.map((u) => [u.id, u]))
  const locationsById = new Map(db.locations.map((l) => [l.id, l]))
  const enriched = turns.map((t) => ({
    ...t,
    assignedToUserName: t.assignedToUserName ?? (t.assignedToUserId ? usersById.get(t.assignedToUserId)?.nombreCompleto : undefined),
    locationNombre: t.locationNombre ?? (t.locationId ? locationsById.get(t.locationId)?.nombre : undefined),
  }))

  response.json(enriched)
})

turnsRouter.post('/', async (request, response) => {
  const { titulo, descripcion, fecha, hora, horaFin, assignedToUserId, locationId, confirmHoursLimit } = request.body ?? {}

  if (!titulo || !fecha || !hora || !assignedToUserId || !locationId) {
    response
      .status(400)
      .json({ message: 'Titulo, fecha, hora, trabajador y ubicacion son requeridos.' })
    return
  }

  const hoursLimit = Number(confirmHoursLimit) || 4

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const assignedUser = db.users.find(
    (user) =>
      user.id === assignedToUserId &&
      user.companyId === companyId &&
      (user.role === 'operativo' || user.role === 'supervisor'),
  )
  const location = db.locations.find(
    (item) =>
      item.id === locationId &&
      item.companyId === companyId,
  )

  if (!assignedUser) {
    response.status(404).json({ message: 'El trabajador no existe o no pertenece a esta empresa.' })
    return
  }

  if (!location) {
    response.status(404).json({ message: 'La ubicacion seleccionada no existe.' })
    return
  }

  // Validate: worker must not already have an active turn on the same date
  const conflict = db.turns.find(
    (t) =>
      t.assignedToUserId === assignedToUserId &&
      t.fecha === fecha &&
      t.companyId === companyId &&
      t.estado !== 'finalizado',
  )

  if (conflict) {
    response.status(409).json({
      message: `${assignedUser.nombreCompleto} ya tiene un turno asignado para el ${fecha} (${conflict.titulo}). Finaliza ese turno antes de crear uno nuevo.`,
    })
    return
  }

  const turn = await createTurn({
    companyId,
    titulo,
    descripcion,
    fecha,
    hora,
    horaFin,
    estado: 'asignado',
    creadoPorUserId: request.authUser!.userId,
    assignedToUserId,
    assignedToUserName: assignedUser.nombreCompleto,
    locationId,
    locationNombre: location.nombre,
    confirmedDeadline: buildConfirmedDeadline(String(fecha), String(hora), hoursLimit),
    confirmHoursLimit: hoursLimit,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  response.status(201).json(turn)
})

/**
 * PATCH /turns/:turnId — Editar datos del turno (fecha, hora, ubicación)
 */
turnsRouter.patch('/:turnId', async (request, response) => {
  const { turnId } = request.params
  const { fecha, hora, horaFin, locationId, locationNombre, descripcion } = request.body ?? {}

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const turn = db.turns.find(
    (item) => item.id === turnId && item.companyId === companyId,
  )

  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  // No permite editar turnos ya finalizados
  if (turn.estado === 'finalizado') {
    response.status(409).json({ message: 'No se puede editar un turno finalizado.' })
    return
  }

  if (fecha) turn.fecha = fecha
  if (hora) turn.hora = hora
  if (horaFin !== undefined) turn.horaFin = horaFin || undefined
  if (locationId) {
    const location = db.locations.find((l) => l.id === locationId && l.companyId === companyId)
    if (location) {
      turn.locationId = locationId
      turn.locationNombre = location.nombre
      turn.titulo = location.nombre  // Título auto se actualiza con ubicación
    }
  }
  if (locationNombre) turn.locationNombre = locationNombre
  if (descripcion !== undefined) turn.descripcion = descripcion

  // Recalcula deadline si cambió la fecha u hora
  if (fecha || hora) {
    const hoursLimit = turn.confirmHoursLimit ?? 4
    turn.confirmedDeadline = buildConfirmedDeadline(turn.fecha, turn.hora, hoursLimit)
  }

  turn.updatedAt = new Date().toISOString()
  await updateTurn(turn)

  response.json(turn)
})

turnsRouter.patch('/:turnId/assign', async (request, response) => {
  const { turnId } = request.params
  const { assignedToUserId } = request.body ?? {}

  if (!assignedToUserId) {
    response.status(400).json({ message: 'El usuario operativo es requerido.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const turn = db.turns.find(
    (item) => item.id === turnId && item.companyId === companyId,
  )

  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  const operativo = db.users.find(
    (user) =>
      user.id === assignedToUserId &&
      user.companyId === companyId &&
      user.role === 'operativo',
  )

  if (!operativo) {
    response.status(404).json({ message: 'Usuario operativo no encontrado.' })
    return
  }

  turn.assignedToUserId = assignedToUserId
  turn.estado = 'asignado'
  turn.updatedAt = new Date().toISOString()
  await updateTurn(turn)

  response.json(turn)
})

turnsRouter.patch('/:turnId/status', async (request, response) => {
  const { turnId } = request.params
  const { estado, rejectionReason, novedad } = request.body as { 
    estado?: TurnStatus
    rejectionReason?: string
    novedad?: string  // Reporte de novedad opcional al confirmar
  }

  if (!estado) {
    response.status(400).json({ message: 'El estado es requerido.' })
    return
  }

  const allowedStatus: TurnStatus[] = [
    'pendiente',
    'asignado',
    'en_proceso',
    'finalizado',
    'confirmado',
    'rechazado',
    'no_aprobado',
  ]

  if (!allowedStatus.includes(estado)) {
    response.status(400).json({ message: 'Estado de turno no valido.' })
    return
  }

  // Rechazo requiere motivo escrito
  if (estado === 'rechazado' && (!rejectionReason || !rejectionReason.trim())) {
    response.status(400).json({ message: 'Debes indicar el motivo del rechazo.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const turn = db.turns.find(
    (item) => item.id === turnId && item.companyId === companyId,
  )

  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  const role = request.authUser!.role
  const isSupervisorByRole = role === 'supervisor'
    || (role !== 'admin' && currentUser?.cargo?.toLowerCase().includes('supervisor'))

  // Check if user has approval permissions
  const position = currentUser?.positionId
    ? db.positions.find((p) => p.id === currentUser.positionId)
    : undefined
  const userModules = position?.permissions ?? []
  const canApprove = isSupervisorByRole || role === 'admin'
    || userModules.includes('geolocalizacion' as any)
    || userModules.includes('configuracion' as any)

  // Cualquier usuario de la empresa puede confirmar/rechazar (el frontend controla quién ve el botón)
  // Solo se bloquea si un operativo intenta cambiar un turno que NO es suyo a un estado distinto de confirmado/rechazado
  if (role === 'operativo' && !isSupervisorByRole && !canApprove
    && turn.assignedToUserId !== request.authUser!.userId
    && !['confirmado', 'rechazado'].includes(estado)) {
    response.status(403).json({ message: 'Solo puedes actualizar turnos asignados a tu usuario.' })
    return
  }

  turn.estado = estado

  // Confirmación del supervisor o admin: registra la firma de aprobación
  // El estado se mantiene en 'en_proceso' — el empleado marca salida para finalizar
  if (estado === 'confirmado') {
    // Si el turno YA tiene checkIn (el empleado ya marcó entrada),
    // esto es una APROBACIÓN del supervisor → registrar firma, mantener en_proceso
    if (turn.attendance?.checkIn) {
      turn.confirmedByUserId = request.authUser!.userId
      turn.confirmedByUserName = currentUser?.nombreCompleto
      turn.confirmedAt = new Date().toISOString()
      turn.estado = 'en_proceso'
    } else {
      // Si NO tiene checkIn, es el EMPLEADO confirmando que asistirá
      // El estado pasa a 'confirmado' (confirmó asistencia, esperando hora de entrada)
      turn.estado = 'confirmado'
    }
  }

  // Rechazo: registra motivo y agrega como novedad
  if (estado === 'rechazado' && rejectionReason) {
    turn.rejectionReason = rejectionReason.trim()
    // Agrega como novedad de tipo rechazo
    const novedadRechazo = {
      id: `nov-${Date.now()}`,
      tipo: 'rechazo' as const,
      descripcion: rejectionReason.trim(),
      reportadoPor: request.authUser!.userId,
      reportadoPorNombre: currentUser?.nombreCompleto,
      createdAt: new Date().toISOString(),
    }
    turn.novedades = [...(turn.novedades ?? []), novedadRechazo]
  }

  // Novedad opcional al confirmar (reporte de observaciones)
  if (novedad && novedad.trim()) {
    const novedadRecord = {
      id: `nov-${Date.now()}`,
      tipo: (estado === 'confirmado' ? 'ingreso' : 'durante') as 'ingreso' | 'durante' | 'salida' | 'rechazo',
      descripcion: novedad.trim(),
      reportadoPor: request.authUser!.userId,
      reportadoPorNombre: currentUser?.nombreCompleto,
      createdAt: new Date().toISOString(),
    }
    turn.novedades = [...(turn.novedades ?? []), novedadRecord]
  }

  turn.updatedAt = new Date().toISOString()
  await updateTurn(turn)

  response.json(turn)
})

/**
 * POST /turns/:turnId/novedades
 * Permite al supervisor agregar un reporte de novedad durante el turno.
 */
turnsRouter.post('/:turnId/novedades', async (request, response) => {
  const { turnId } = request.params
  const { descripcion, tipo } = request.body as { descripcion?: string; tipo?: string }

  if (!descripcion || !descripcion.trim()) {
    response.status(400).json({ message: 'La descripción de la novedad es requerida.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const role = request.authUser!.role

  const isSupervisorByRole = role === 'supervisor' || role === 'admin'
    || (currentUser?.cargo?.toLowerCase().includes('supervisor'))

  if (!isSupervisorByRole) {
    response.status(403).json({ message: 'Solo supervisores y administradores pueden reportar novedades.' })
    return
  }

  const turn = db.turns.find(
    (item) => item.id === turnId && item.companyId === companyId,
  )

  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  const validTipos = ['ingreso', 'durante', 'salida', 'rechazo'] as const
  const tipoNovedad = validTipos.includes(tipo as any) ? (tipo as typeof validTipos[number]) : 'durante'

  const novedad = {
    id: `nov-${Date.now()}`,
    tipo: tipoNovedad,
    descripcion: descripcion.trim(),
    reportadoPor: request.authUser!.userId,
    reportadoPorNombre: currentUser?.nombreCompleto,
    createdAt: new Date().toISOString(),
  }

  turn.novedades = [...(turn.novedades ?? []), novedad]
  turn.updatedAt = new Date().toISOString()
  await updateTurn(turn)

  response.json({ message: 'Novedad registrada.', novedad, turn })
})

/**
 * GET /turns/:turnId/available-workers
 * Devuelve empleados operativos sin turno activo en la misma fecha del turno.
 */
turnsRouter.get('/:turnId/available-workers', async (request, response) => {
  const { turnId } = request.params
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const turn = db.turns.find((t) => t.id === turnId && t.companyId === companyId)
  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  // Empleados con turno activo ese día
  const busyWorkerIds = new Set(
    db.turns
      .filter((t) => t.companyId === companyId && t.fecha === turn.fecha && t.estado !== 'finalizado' && t.estado !== 'rechazado')
      .map((t) => t.assignedToUserId)
      .filter(Boolean)
  )

  const available = db.users.filter(
    (u) => u.companyId === companyId && u.role === 'operativo' && u.activa && !busyWorkerIds.has(u.id)
  )

  response.json(available.map((u) => ({ id: u.id, nombreCompleto: u.nombreCompleto, cargo: u.cargo })))
})

/**
 * PATCH /turns/:turnId/reassign
 * Rechaza el turno del empleado actual y lo reasigna a otro disponible.
 */
turnsRouter.patch('/:turnId/reassign', async (request, response) => {
  const { turnId } = request.params
  const { newUserId } = request.body as { newUserId?: string }

  if (!newUserId) {
    response.status(400).json({ message: 'El nuevo empleado es requerido.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const turn = db.turns.find((t) => t.id === turnId && t.companyId === companyId)
  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  const newWorker = db.users.find((u) => u.id === newUserId && u.companyId === companyId && u.role === 'operativo')
  if (!newWorker) {
    response.status(404).json({ message: 'El empleado seleccionado no existe.' })
    return
  }

  // Verifica que el nuevo empleado no tenga turno ese día
  const conflict = db.turns.find(
    (t) => t.assignedToUserId === newUserId && t.fecha === turn.fecha && t.estado !== 'finalizado' && t.estado !== 'rechazado' && t.id !== turnId
  )
  if (conflict) {
    response.status(409).json({ message: `${newWorker.nombreCompleto} ya tiene un turno asignado para ese día.` })
    return
  }

  turn.assignedToUserId  = newWorker.id
  turn.assignedToUserName = newWorker.nombreCompleto
  turn.estado    = 'asignado'
  turn.confirmedDeadline = buildConfirmedDeadline(turn.fecha, turn.hora, turn.confirmHoursLimit ?? 4)
  turn.updatedAt = new Date().toISOString()

  await updateTurn(turn)
  response.json(turn)
})

turnsRouter.delete('/:turnId', async (request, response) => {
  const turnId = String(request.params.turnId)

  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const turn = db.turns.find(
    (item) => item.id === turnId && item.companyId === companyId,
  )

  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  // Prevent deleting a turn that already has attendance registered
  if (turn.attendance?.checkIn) {
    response.status(409).json({
      message: 'No se puede eliminar un turno con asistencia ya registrada.',
    })
    return
  }

  await deleteTurn(turnId)
  response.status(204).send()
})

/**
 * GET /turns/hours-history
 * Devuelve el historial de horas trabajadas (horasTurno) de la empresa.
 * Query params: from (fecha inicio), to (fecha fin), userId (opcional)
 */
turnsRouter.get('/hours-history', requireRole(['admin', 'supervisor']), async (request, response) => {
  const { from, to, userId } = request.query as { from?: string; to?: string; userId?: string }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const col = await getHorasTurnoCollection()

  // Build filter
  const filter: Record<string, unknown> = { companyId }
  if (from || to) {
    filter.fecha = {}
    if (from) (filter.fecha as Record<string, string>).$gte = from
    if (to) (filter.fecha as Record<string, string>).$lte = to
  }
  if (userId) filter.userId = userId

  const records = await col.find(filter).project({ _id: 0 }).sort({ fecha: -1 }).limit(500).toArray()

  // Summary
  const totalHoras = records.reduce((s, r) => s + (r.horasTrabajadas ?? 0), 0)
  const totalOrdinarias = records.reduce((s, r) => s + (r.horasOrdinarias ?? 0), 0)
  const totalDominicales = records.reduce((s, r) => s + (r.horasDominicales ?? 0), 0)
  const totalFestivas = records.reduce((s, r) => s + (r.horasFestivas ?? 0), 0)

  response.json({
    records,
    summary: {
      total: records.length,
      totalHoras: Math.round(totalHoras * 100) / 100,
      totalOrdinarias: Math.round(totalOrdinarias * 100) / 100,
      totalDominicales: Math.round(totalDominicales * 100) / 100,
      totalFestivas: Math.round(totalFestivas * 100) / 100,
    },
  })
})

/**
 * GET /turns/my-hours
 * Devuelve las horas trabajadas del usuario autenticado (empleado puede ver las suyas).
 * Query: from, to (opcional)
 */
turnsRouter.get('/my-hours', async (request, response) => {
  const { from, to } = request.query as { from?: string; to?: string }
  const userId = request.authUser!.userId

  const col = await getHorasTurnoCollection()
  const filter: Record<string, unknown> = { userId }
  if (from || to) {
    filter.fecha = {}
    if (from) (filter.fecha as Record<string, string>).$gte = from
    if (to) (filter.fecha as Record<string, string>).$lte = to
  }

  const records = await col.find(filter).project({ _id: 0 }).sort({ fecha: -1 }).limit(100).toArray()

  const totalHoras = records.reduce((s, r) => s + (r.horasTrabajadas ?? 0), 0)
  response.json({
    records,
    summary: {
      total: records.length,
      totalHoras: Math.round(totalHoras * 100) / 100,
    },
  })
})

/**
 * GET /turns/rejected-report
 * Devuelve todos los turnos rechazados con sus motivos y novedades.
 */
turnsRouter.get('/rejected-report', requireRole(['admin', 'supervisor']), async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const rejected = db.turns
    .filter((t) => t.companyId === companyId && t.estado === 'rechazado')
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .map((t) => ({
      id: t.id,
      titulo: t.titulo,
      fecha: t.fecha,
      hora: t.hora,
      horaFin: t.horaFin,
      assignedToUserName: t.assignedToUserName,
      assignedToUserId: t.assignedToUserId,
      locationNombre: t.locationNombre,
      rejectionReason: t.rejectionReason,
      novedades: t.novedades ?? [],
      updatedAt: t.updatedAt,
    }))

  response.json({ total: rejected.length, rejected })
})
