import { Router } from 'express'
import type { AccessModule } from '../types.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { createPosition, readDatabase, updatePosition } from '../lib/database.js'

export const positionsRouter = Router()

positionsRouter.use(requireAuth)

positionsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser?.companyId ||
    db.users.find((user) => user.id === request.authUser?.userId)?.companyId ||
    ''
  const positions = db.positions.filter(
    (position) => position.companyId === companyId,
  )

  response.json(positions)
})

positionsRouter.post('/', requireRole(['admin']), async (request, response) => {
  const { nombre, descripcion, permissions, permissionLevels, valorHora } = request.body ?? {}

  if (!nombre) {
    response.status(400).json({ message: 'El nombre del cargo es requerido.' })
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

  const position = await createPosition({
    companyId,
    nombre,
    descripcion,
    permissions: Array.isArray(permissions)
      ? permissions.filter((item): item is AccessModule => typeof item === 'string')
      : ['dashboard', 'turnos-fijos'],
    permissionLevels: permissionLevels && typeof permissionLevels === 'object' ? permissionLevels : undefined,
    valorHora: typeof valorHora === 'number' ? valorHora : undefined,
    activa: true,
    createdAt: new Date().toISOString(),
  })

  response.status(201).json(position)
})

positionsRouter.patch('/:positionId', requireRole(['admin']), async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  const position = db.positions.find(
    (item) => item.id === request.params.positionId && item.companyId === companyId,
  )

  if (!position) {
    response.status(404).json({ message: 'El cargo no existe para la compania autenticada.' })
    return
  }

  const { nombre, descripcion, permissions, permissionLevels, valorHora } = request.body ?? {}
  const nextPermissions = Array.isArray(permissions)
    ? permissions.filter((item): item is AccessModule => typeof item === 'string')
    : position.permissions

  const updatedPosition = await updatePosition({
    ...position,
    nombre: typeof nombre === 'string' && nombre ? nombre : position.nombre,
    descripcion: descripcion === undefined ? position.descripcion
      : typeof descripcion === 'string' ? descripcion : position.descripcion,
    permissions: nextPermissions.length ? nextPermissions : position.permissions,
    permissionLevels: permissionLevels && typeof permissionLevels === 'object' ? permissionLevels : position.permissionLevels,
    valorHora: typeof valorHora === 'number' ? valorHora : position.valorHora,
  })

  response.json(updatedPosition)
})
