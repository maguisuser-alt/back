import { Router } from 'express'
import { createUser, createUserInvitation, readDatabase, updateUser, deleteUser } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { resolveAllowedModules } from '../lib/access.js'
import { invalidateAccess } from '../lib/access-cache.js'
import { canManageUsers, checkStatusChange, publicUser } from '../lib/user-admin.js'

export const usersRouter = Router()

usersRouter.use(requireAuth)

// Supervisor can read users, create invitations. Admin can do everything.
const adminOnly = requireRole(['admin'])
const adminOrSupervisor = requireRole(['admin', 'supervisor'])

usersRouter.get('/', adminOrSupervisor, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''
  const users = db.users.filter((user) => user.companyId === companyId)

  response.json(users.map(publicUser))
})

/**
 * PATCH /users/:userId/status — activar / desactivar un usuario de la empresa.
 * Body: { activa: boolean }
 * Lo puede hacer el admin y cualquier cargo con opciones de admin sobre los
 * empleados (editar-empleados / eliminar-empleados). Reglas en user-admin.ts.
 * El usuario desactivado queda bloqueado en su siguiente petición.
 */
usersRouter.patch('/:userId/status', async (request, response) => {
  const { activa } = request.body ?? {}
  if (typeof activa !== 'boolean') {
    response.status(400).json({ message: 'El campo "activa" (true/false) es requerido.' })
    return
  }
  const db = await readDatabase()
  const actor = db.users.find((u) => u.id === request.authUser!.userId)
  if (!actor) { response.status(401).json({ message: 'Sesion no valida.' }); return }
  const companyId = actor.companyId || request.authUser!.companyId
  if (!canManageUsers(actor, resolveAllowedModules(db, actor))) {
    response.status(403).json({ message: 'No tienes permisos para activar o desactivar usuarios.' })
    return
  }
  const target = db.users.find((u) => u.id === request.params.userId && u.companyId === companyId)
  if (!target) { response.status(404).json({ message: 'Usuario no encontrado.' }); return }

  const activeAdmins = db.users.filter((u) => u.companyId === companyId && u.role === 'admin' && u.activa !== false).length
  const check = checkStatusChange({ actor, target, activa, activeAdmins })
  if (!check.ok) { response.status(check.status).json({ message: check.message }); return }

  target.activa = activa
  await updateUser(target)
  invalidateAccess({ userId: target.id })
  response.json({
    message: `${target.nombreCompleto} ${activa ? 'activado' : 'desactivado'}.`,
    user: publicUser(target),
  })
})

usersRouter.get('/invitations', adminOrSupervisor, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''
  const invitations = db.userInvitations
    .filter((invitation) => invitation.companyId === companyId)
    .map((invitation) => ({
      ...invitation,
      invitePath: `/registro-integrante/${invitation.token}`,
    }))

  response.json(invitations)
})

usersRouter.post('/invitations', adminOrSupervisor, async (request, response) => {
  const { positionId, role } = request.body ?? {}

  if (!positionId) {
    response.status(400).json({ message: 'El cargo es requerido para generar el link.' })
    return
  }

  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  if (!companyId) {
    response.status(400).json({
      message: 'No fue posible identificar la compania asociada al usuario autenticado.',
    })
    return
  }

  const position = db.positions.find(
    (item) => item.id === positionId && item.companyId === companyId,
  )

  if (!position) {
    response.status(404).json({ message: 'El cargo seleccionado no existe.' })
    return
  }

  // Valida el rol según el tipo de empresa
  const company = db.companies.find((c) => c.id === companyId)
  const companyType = company?.tipo ?? 'empresa'
  const validRoles = companyType === 'academia'
    ? ['admin', 'docente', 'estudiante']
    : ['admin', 'supervisor', 'operativo']

  const resolvedRole = validRoles.includes(role) ? role : (companyType === 'academia' ? 'estudiante' : 'operativo')

  const invitation = await createUserInvitation({
    companyId,
    positionId,
    cargo: position.nombre,
    role: resolvedRole,
    invitedByUserId: request.authUser!.userId,
  })

  response.status(201).json({
    ...invitation,
    invitePath: `/registro-integrante/${invitation.token}`,
  })
})

usersRouter.post('/', adminOnly, async (request, response) => {
  const {
    nombreCompleto,
    tipoDocumento,
    numeroDocumento,
    correo,
    telefono,
    positionId,
  } = request.body ?? {}

  if (
    !nombreCompleto ||
    !tipoDocumento ||
    !numeroDocumento ||
    !correo ||
    !telefono ||
    !positionId
  ) {
    response.status(400).json({ message: 'Faltan datos para registrar el usuario.' })
    return
  }

  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  if (!companyId) {
    response.status(400).json({
      message: 'No fue posible identificar la compania asociada al usuario autenticado.',
    })
    return
  }

  const duplicatedUser = db.users.find(
    (user) => user.correo === correo || user.numeroDocumento === numeroDocumento,
  )

  if (duplicatedUser) {
    response.status(409).json({ message: 'El usuario ya existe.' })
    return
  }

  const position = db.positions.find(
    (item) => item.id === positionId && item.companyId === companyId,
  )

  if (!position) {
    response.status(404).json({ message: 'El puesto operativo no existe.' })
    return
  }

  const user = await createUser({
    companyId,
    nombreCompleto,
    tipoDocumento,
    numeroDocumento,
    correo,
    telefono,
    cargo: position.nombre,
    role: 'operativo',
    positionId,
    activa: true,
    createdAt: new Date().toISOString(),
  })

  response.status(201).json(user)
})

/**
 * GET /users/:userId — detalle de un empleado
 */
usersRouter.get('/:userId', adminOrSupervisor, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((u) => u.id === request.authUser!.userId)?.companyId || ''

  const user = db.users.find(
    (u) => u.id === request.params.userId && u.companyId === companyId,
  )

  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado.' })
    return
  }

  response.json(publicUser(user))
})

/**
 * PATCH /users/:userId — editar datos del empleado
 */
usersRouter.patch('/:userId', adminOnly, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((u) => u.id === request.authUser!.userId)?.companyId || ''

  const user = db.users.find(
    (u) => u.id === request.params.userId && u.companyId === companyId,
  )

  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado.' })
    return
  }

  const {
    nombreCompleto,
    tipoDocumento,
    numeroDocumento,
    correo,
    telefono,
    cargo,
    role,
    positionId,
    activa,
  } = request.body ?? {}

  if (nombreCompleto !== undefined) user.nombreCompleto = String(nombreCompleto)
  if (tipoDocumento !== undefined)  user.tipoDocumento  = String(tipoDocumento)
  if (numeroDocumento !== undefined) user.numeroDocumento = String(numeroDocumento)
  if (correo !== undefined)         user.correo         = String(correo)
  if (telefono !== undefined)       user.telefono       = telefono ? String(telefono) : undefined
  if (activa !== undefined && Boolean(activa) !== (user.activa !== false)) {
    const actor = db.users.find((u) => u.id === request.authUser!.userId)
    const activeAdmins = db.users.filter((u) => u.companyId === companyId && u.role === 'admin' && u.activa !== false).length
    const check = checkStatusChange({ actor: actor ?? { id: request.authUser!.userId, role: 'admin' }, target: user, activa: Boolean(activa), activeAdmins })
    if (!check.ok) { response.status(check.status).json({ message: check.message }); return }
  }
  if (role !== undefined)           user.role           = role
  if (activa !== undefined)         user.activa         = Boolean(activa)

  // Al cambiar positionId, actualiza automáticamente el cargo con el nombre de la posición
  if (positionId !== undefined) {
    user.positionId = positionId || undefined
    if (positionId) {
      const position = db.positions.find((p) => p.id === positionId && p.companyId === companyId)
      if (position) {
        user.cargo = position.nombre
      }
    }
  } else if (cargo !== undefined) {
    user.cargo = String(cargo)
  }

  await updateUser(user)
  invalidateAccess({ userId: user.id })
  response.json(publicUser(user))
})

/**
 * DELETE /users/:userId — eliminar empleado
 */
usersRouter.delete('/:userId', adminOnly, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((u) => u.id === request.authUser!.userId)?.companyId || ''

  const user = db.users.find(
    (u) => u.id === request.params.userId && u.companyId === companyId,
  )

  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado.' })
    return
  }

  // No permitir eliminarse a sí mismo
  if (user.id === request.authUser!.userId) {
    response.status(403).json({ message: 'No puedes eliminar tu propia cuenta.' })
    return
  }

  await deleteUser(user.id, companyId)
  invalidateAccess({ userId: user.id })
  response.status(204).send()
})

/**
 * POST /users/:userId/reset-face — Admin: permite al usuario re-registrar su rostro
 * Afecta tanto al descriptor legacy como al EnhancedFaceProfile.
 * body: { motivo?: string, limpiarDescriptores?: boolean }
 */
usersRouter.post('/:userId/reset-face', adminOnly, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((u) => u.id === request.authUser!.userId)?.companyId || ''

  const user = db.users.find(
    (u) => u.id === request.params.userId && u.companyId === companyId,
  )

  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado.' })
    return
  }

  const { motivo, limpiarDescriptores } = request.body ?? {}
  user.allowFaceReRegister = true

  if (user.faceProfile) {
    user.faceProfile.requiereReRegistro = true
    if (motivo) user.faceProfile.motivoReRegistro = String(motivo)
    if (limpiarDescriptores === true) {
      user.faceProfile.faceDescriptors = []
      user.faceProfile.estado = 'pendiente_verificacion'
    }
  }

  if (limpiarDescriptores === true) {
    user.faceDescriptor = undefined
    user.faceRegisteredAt = undefined
  }

  await updateUser(user)

  response.json({
    message: `Registro facial habilitado nuevamente para ${user.nombreCompleto}.`,
    limpioDescriptoresAnteriores: Boolean(limpiarDescriptores),
    motivo: motivo ?? null,
  })
})

/**
 * POST /users/:userId/face-estado — Admin: cambia el estado del perfil biométrico facial
 * body: { estado: 'activo' | 'suspendido' | 'bloqueado', motivo?: string }
 */
usersRouter.post('/:userId/face-estado', adminOnly, async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((u) => u.id === request.authUser!.userId)?.companyId || ''

  const user = db.users.find((u) => u.id === request.params.userId && u.companyId === companyId)
  if (!user) return response.status(404).json({ message: 'Usuario no encontrado.' })

  const { estado, motivo } = request.body ?? {}
  const estadosValidos = ['activo', 'suspendido', 'pendiente_verificacion', 'bloqueado']
  if (!estadosValidos.includes(String(estado))) {
    return response.status(400).json({ message: `Estado inválido. Validos: ${estadosValidos.join(', ')}` })
  }

  if (!user.faceProfile) {
    user.faceProfile = {
      faceDescriptors: user.faceDescriptor ? [{ descriptor: user.faceDescriptor, registeredAt: user.faceRegisteredAt ?? new Date().toISOString() }] : [],
      registeredAt: user.faceRegisteredAt ?? new Date().toISOString(),
      verificationCount: 0,
      failedAttempts: 0,
      estado: estado as any,
    }
  } else {
    user.faceProfile.estado = estado as any
    if (estado === 'bloqueado') {
      user.faceProfile.lockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    } else if (estado === 'activo') {
      user.faceProfile.lockedUntil = undefined
    }
    if (motivo) user.faceProfile.motivoReRegistro = String(motivo)
  }

  await updateUser(user)
  response.json({ message: 'Estado biométrico actualizado.', estado, userFace: user.faceProfile })
})
