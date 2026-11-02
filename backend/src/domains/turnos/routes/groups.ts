import { Router } from 'express'
import { resolveCompanyIdForUser } from '../lib/access.js'
import { createTurn, readDatabase, writeDatabase } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { OperationGroup } from '../types.js'

export const groupsRouter = Router()

groupsRouter.use(requireAuth, requireRole(['admin']))

/**
 * GET /groups — lista todos los grupos operativos de la empresa
 */
groupsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const groups = db.groups.filter((g) => g.companyId === companyId)

  // Enriquece con datos de ubicación y miembros
  const usersById = new Map(db.users.map((u) => [u.id, u]))
  const locsById  = new Map(db.locations.map((l) => [l.id, l]))

  const enriched = groups.map((g) => ({
    ...g,
    locationNombre: g.locationNombre ?? locsById.get(g.locationId)?.nombre,
    members: g.memberUserIds.map((uid) => {
      const u = usersById.get(uid)
      return { id: uid, nombre: u?.nombreCompleto ?? '', cargo: u?.cargo ?? '', role: u?.role ?? 'operativo' }
    }),
    supervisor: g.supervisorUserId ? usersById.get(g.supervisorUserId) : null,
  }))

  response.json(enriched)
})

/**
 * POST /groups — crear un grupo operativo
 */
groupsRouter.post('/', async (request, response) => {
  const { nombre, locationId, horario, horarioFin, memberUserIds, supervisorUserId } = request.body ?? {}

  if (!nombre || !locationId || !horario) {
    response.status(400).json({ message: 'Nombre, ubicación y horario son requeridos.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const location = db.locations.find((l) => l.id === locationId && l.companyId === companyId)
  if (!location) {
    response.status(404).json({ message: 'Ubicación no encontrada.' })
    return
  }

  const group: OperationGroup = {
    id: `group-${Date.now()}`,
    companyId,
    nombre,
    locationId,
    locationNombre: location.nombre,
    horario,
    horarioFin: horarioFin || undefined,
    memberUserIds: Array.isArray(memberUserIds) ? memberUserIds : [],
    supervisorUserId: supervisorUserId || undefined,
    activo: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  db.groups.push(group)
  await writeDatabase(db)

  response.status(201).json(group)
})

/**
 * PATCH /groups/:groupId — editar grupo (nombre, miembros, supervisor, horario)
 */
groupsRouter.patch('/:groupId', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const group = db.groups.find((g) => g.id === request.params.groupId && g.companyId === companyId)
  if (!group) {
    response.status(404).json({ message: 'Grupo no encontrado.' })
    return
  }

  const { nombre, locationId, horario, horarioFin, memberUserIds, supervisorUserId, activo } = request.body ?? {}

  if (nombre !== undefined) group.nombre = String(nombre)
  if (locationId !== undefined) {
    const loc = db.locations.find((l) => l.id === locationId && l.companyId === companyId)
    if (loc) { group.locationId = locationId; group.locationNombre = loc.nombre }
  }
  if (horario !== undefined)       group.horario = String(horario)
  if (horarioFin !== undefined)    group.horarioFin = horarioFin || undefined
  if (Array.isArray(memberUserIds)) group.memberUserIds = memberUserIds
  if (supervisorUserId !== undefined) group.supervisorUserId = supervisorUserId || undefined
  if (activo !== undefined)        group.activo = Boolean(activo)
  group.updatedAt = new Date().toISOString()

  await writeDatabase(db)
  response.json(group)
})

/**
 * POST /groups/:groupId/generate-turns — genera turnos para todos los miembros del grupo en una fecha
 */
groupsRouter.post('/:groupId/generate-turns', async (request, response) => {
  const { fecha } = request.body ?? {}

  if (!fecha) {
    response.status(400).json({ message: 'La fecha es requerida.' })
    return
  }

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const group = db.groups.find((g) => g.id === request.params.groupId && g.companyId === companyId)
  if (!group) {
    response.status(404).json({ message: 'Grupo no encontrado.' })
    return
  }

  if (!group.memberUserIds.length) {
    response.status(400).json({ message: 'El grupo no tiene miembros asignados.' })
    return
  }

  // Incluye supervisor si tiene uno asignado
  const allUserIds = group.supervisorUserId
    ? [...new Set([group.supervisorUserId, ...group.memberUserIds])]
    : group.memberUserIds

  const usersById = new Map(db.users.map((u) => [u.id, u]))
  const created: string[] = []
  const errors: string[] = []

  for (const userId of allUserIds) {
    const user = usersById.get(userId)
    if (!user) { errors.push(userId); continue }

    // Verifica conflicto
    const conflict = db.turns.find(
      (t) => t.assignedToUserId === userId && t.fecha === fecha && t.companyId === companyId && t.estado !== 'finalizado' && t.estado !== 'rechazado'
    )
    if (conflict) { errors.push(`${user.nombreCompleto} (conflicto)`); continue }

    try {
      await createTurn({
        companyId,
        titulo: group.locationNombre ?? group.nombre,
        fecha: String(fecha),
        hora: group.horario,
        horaFin: group.horarioFin,
        estado: 'asignado',
        creadoPorUserId: request.authUser!.userId,
        assignedToUserId: userId,
        assignedToUserName: user.nombreCompleto,
        locationId: group.locationId,
        locationNombre: group.locationNombre,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      created.push(user.nombreCompleto)
    } catch {
      errors.push(user.nombreCompleto)
    }
  }

  response.json({
    message: `${created.length} turno(s) creado(s) para el grupo "${group.nombre}" el ${fecha}.`,
    created: created.length,
    errors,
  })
})

/**
 * DELETE /groups/:groupId — eliminar grupo
 */
groupsRouter.delete('/:groupId', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const idx = db.groups.findIndex((g) => g.id === request.params.groupId && g.companyId === companyId)
  if (idx === -1) {
    response.status(404).json({ message: 'Grupo no encontrado.' })
    return
  }

  db.groups.splice(idx, 1)
  await writeDatabase(db)
  response.status(204).send()
})
