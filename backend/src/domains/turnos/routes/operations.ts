import { Router } from 'express'
import { resolveCompanyIdForUser } from '../lib/access.js'
import { readDatabase } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const operationsRouter = Router()

operationsRouter.use(requireAuth, requireRole(['admin', 'supervisor']))

/**
 * GET /operations/by-location
 * Agrupa turnos por ubicación con detalle de empleados asignados.
 * Query: ?fecha=YYYY-MM-DD (opcional, default: hoy)
 */
operationsRouter.get('/by-location', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const fecha = typeof request.query.fecha === 'string' && request.query.fecha
    ? request.query.fecha
    : new Date().toISOString().slice(0, 10)

  const company = db.companies.find((c) => c.id === companyId)
  const locations = db.locations.filter((l) => l.companyId === companyId)
  const turnsToday = db.turns.filter((t) => t.companyId === companyId && t.fecha === fecha)
  const usersById = new Map(db.users.map((u) => [u.id, u]))

  const result = locations.map((loc) => {
    const turnsAtLocation = turnsToday.filter((t) => t.locationId === loc.id)
    const empleados = turnsAtLocation.map((t) => {
      const user = t.assignedToUserId ? usersById.get(t.assignedToUserId) : undefined
      return {
        turnId: t.id,
        userId: t.assignedToUserId ?? '',
        nombre: user?.nombreCompleto ?? t.assignedToUserName ?? 'Sin asignar',
        cargo: user?.cargo ?? '',
        role: user?.role ?? 'operativo',
        turno: t.titulo,
        horario: t.horaFin ? `${t.hora} - ${t.horaFin}` : t.hora,
        estado: t.estado,
        checkIn: t.attendance?.checkIn?.markedAt ?? null,
        checkOut: t.attendance?.checkOut?.markedAt ?? null,
      }
    })

    // URL de Google Maps con las coordenadas
    const mapsUrl = loc.latitud && loc.longitud
      ? `https://www.google.com/maps/dir/?api=1&destination=${loc.latitud},${loc.longitud}`
      : null

    return {
      locationId: loc.id,
      nombre: loc.nombre,
      direccion: loc.direccion ?? '',
      latitud: loc.latitud,
      longitud: loc.longitud,
      radioTolerancia: loc.radioTolerancia,
      mapsUrl,
      mapsViewUrl: loc.latitud && loc.longitud
        ? `https://www.google.com/maps?q=${loc.latitud},${loc.longitud}`
        : null,
      totalTurnos: turnsAtLocation.length,
      totalEmpleados: empleados.length,
      enCurso: empleados.filter((e) => e.estado === 'en_proceso' || e.estado === 'confirmado').length,
      finalizados: empleados.filter((e) => e.estado === 'finalizado').length,
      empleados,
    }
  }).filter((loc) => loc.totalTurnos > 0) // Solo ubicaciones con turnos ese día

  response.json({
    fecha,
    tipo: company?.tipo ?? 'empresa',
    companyName: company?.nombre ?? '',
    locations: result,
  })
})

/**
 * GET /operations/company-info
 * Info básica de la empresa para diferenciar tipo en el frontend
 */
operationsRouter.get('/company-info', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const company = db.companies.find((c) => c.id === companyId)

  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  response.json({
    id: company.id,
    nombre: company.nombre,
    tipo: company.tipo,
    enabledModules: company.enabledModules,
    settings: company.settings,
  })
})

/**
 * GET /operations/turns-grouped
 * Lista turnos agrupados por (ubicación + fecha + horario).
 * Cada grupo muestra los empleados asignados.
 * Query: ?fecha=YYYY-MM-DD&locationId=xxx (opcionales)
 */
operationsRouter.get('/turns-grouped', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const filterFecha = typeof request.query.fecha === 'string' ? request.query.fecha : ''
  const filterLocation = typeof request.query.locationId === 'string' ? request.query.locationId : ''

  let companyTurns = db.turns.filter((t) => t.companyId === companyId)
  if (filterFecha)    companyTurns = companyTurns.filter((t) => t.fecha === filterFecha)
  if (filterLocation) companyTurns = companyTurns.filter((t) => t.locationId === filterLocation)

  const usersById = new Map(db.users.map((u) => [u.id, u]))
  const locsById  = new Map(db.locations.map((l) => [l.id, l]))

  // Agrupa por clave: locationId + fecha + hora + horaFin
  const groupMap = new Map<string, {
    key: string
    locationId: string
    locationNombre: string
    mapsUrl: string | null
    fecha: string
    hora: string
    horaFin: string
    titulo: string
    empleados: Array<{
      turnId: string
      userId: string
      nombre: string
      cargo: string
      role: string
      estado: string
      checkIn: string | null
      checkOut: string | null
    }>
  }>()

  for (const t of companyTurns) {
    const key = `${t.locationId ?? 'none'}|${t.fecha}|${t.hora}|${t.horaFin ?? ''}`
    const loc = t.locationId ? locsById.get(t.locationId) : undefined
    const user = t.assignedToUserId ? usersById.get(t.assignedToUserId) : undefined

    const existing = groupMap.get(key) ?? {
      key,
      locationId: t.locationId ?? '',
      locationNombre: loc?.nombre ?? t.locationNombre ?? '',
      mapsUrl: loc?.latitud && loc?.longitud
        ? `https://www.google.com/maps?q=${loc.latitud},${loc.longitud}`
        : null,
      fecha: t.fecha,
      hora: t.hora,
      horaFin: t.horaFin ?? '',
      titulo: t.titulo,
      empleados: [],
    }

    existing.empleados.push({
      turnId: t.id,
      userId: t.assignedToUserId ?? '',
      nombre: user?.nombreCompleto ?? t.assignedToUserName ?? 'Sin asignar',
      cargo: user?.cargo ?? '',
      role: user?.role ?? 'operativo',
      estado: t.estado,
      checkIn: t.attendance?.checkIn?.markedAt ?? null,
      checkOut: t.attendance?.checkOut?.markedAt ?? null,
    })

    groupMap.set(key, existing)
  }

  const groups = [...groupMap.values()].sort((a, b) => {
    if (a.fecha !== b.fecha) return b.fecha.localeCompare(a.fecha)
    return a.hora.localeCompare(b.hora)
  })

  response.json(groups)
})

/**
 * PATCH /operations/turns/:turnId/reassign
 * Reasigna un turno individual a otro empleado.
 * Body: { newUserId: string }
 */
operationsRouter.patch('/turns/:turnId/reassign', async (request, response) => {
  const { newUserId } = request.body ?? {}
  if (!newUserId) {
    response.status(400).json({ message: 'El nuevo empleado es requerido.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const turn = db.turns.find((t) => t.id === request.params.turnId && t.companyId === companyId)
  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  const newUser = db.users.find((u) => u.id === newUserId && u.companyId === companyId)
  if (!newUser) {
    response.status(404).json({ message: 'Empleado no encontrado.' })
    return
  }

  // Verifica conflicto
  const conflict = db.turns.find(
    (t) => t.assignedToUserId === newUserId && t.fecha === turn.fecha &&
      t.companyId === companyId && t.id !== turn.id &&
      t.estado !== 'finalizado' && t.estado !== 'rechazado'
  )
  if (conflict) {
    response.status(409).json({
      message: `${newUser.nombreCompleto} ya tiene turno el ${turn.fecha}.`,
    })
    return
  }

  turn.assignedToUserId = newUser.id
  turn.assignedToUserName = newUser.nombreCompleto
  turn.estado = 'asignado'
  turn.updatedAt = new Date().toISOString()

  const { updateTurn } = await import('../lib/database.js')
  await updateTurn(turn)

  response.json(turn)
})

/**
 * DELETE /operations/turns/:turnId/remove
 * Quita un empleado del turno (elimina el turno individual).
 * Solo si no tiene asistencia registrada.
 */
operationsRouter.delete('/turns/:turnId/remove', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const turn = db.turns.find((t) => t.id === request.params.turnId && t.companyId === companyId)
  if (!turn) {
    response.status(404).json({ message: 'Turno no encontrado.' })
    return
  }

  if (turn.attendance?.checkIn) {
    response.status(409).json({ message: 'No se puede quitar un empleado con asistencia registrada.' })
    return
  }

  const { deleteTurn } = await import('../lib/database.js')
  await deleteTurn(turn.id)
  response.status(204).send()
})

/**
 * POST /operations/turns/add-employee
 * Agrega un empleado a un turno existente (crea un turno nuevo con el mismo horario/ubicación).
 * Body: { userId, fecha, hora, horaFin, locationId, titulo }
 */
operationsRouter.post('/turns/add-employee', async (request, response) => {
  const { userId, fecha, hora, horaFin, locationId, titulo } = request.body ?? {}

  if (!userId || !fecha || !hora || !locationId) {
    response.status(400).json({ message: 'userId, fecha, hora y locationId son requeridos.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const user = db.users.find((u) => u.id === userId && u.companyId === companyId)
  if (!user) {
    response.status(404).json({ message: 'Empleado no encontrado.' })
    return
  }

  const loc = db.locations.find((l) => l.id === locationId && l.companyId === companyId)

  // Verifica conflicto
  const conflict = db.turns.find(
    (t) => t.assignedToUserId === userId && t.fecha === fecha &&
      t.companyId === companyId && t.estado !== 'finalizado' && t.estado !== 'rechazado'
  )
  if (conflict) {
    response.status(409).json({ message: `${user.nombreCompleto} ya tiene turno el ${fecha}.` })
    return
  }

  const { createTurn } = await import('../lib/database.js')
  const turn = await createTurn({
    companyId,
    titulo: titulo || loc?.nombre || 'Turno',
    fecha: String(fecha),
    hora: String(hora),
    horaFin: horaFin || undefined,
    estado: 'asignado',
    creadoPorUserId: request.authUser!.userId,
    assignedToUserId: userId,
    assignedToUserName: user.nombreCompleto,
    locationId: String(locationId),
    locationNombre: loc?.nombre,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  response.status(201).json(turn)
})
