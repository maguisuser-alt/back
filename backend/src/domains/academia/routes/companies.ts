import { Router } from 'express'
import { resolveAllowedModules, resolvePermissionLevels } from '../lib/access.js'
import { readDatabase } from '../lib/database.js'
import { requireAuth } from '../middleware/auth.js'

export const companiesRouter = Router()
companiesRouter.use(requireAuth)

/** GET /api/companies/me — datos de la institución del usuario autenticado. */
companiesRouter.get('/me', async (request, response) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = user?.companyId || request.authUser!.companyId
  const company = db.companies.find((c) => c.id === companyId)
  if (!company) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  response.json(company)
})

/**
 * GET /api/companies/management — resumen para el admin (y refresco de módulos).
 * El frontend lo usa para re-sincronizar allowedModules sin re-login.
 */
companiesRouter.get('/management', async (request, response) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = user?.companyId || request.authUser!.companyId
  const company = db.companies.find((c) => c.id === companyId) ?? null

  const users = db.users.filter((u) => u.companyId === companyId)
  const locations = db.locations.filter((l) => l.companyId === companyId)

  response.json({
    company,
    currentUser: user
      ? {
          id: user.id,
          companyId: user.companyId,
          role: user.role,
          positionId: user.positionId,
          allowedModules: resolveAllowedModules(db, user),
          permissionLevels: resolvePermissionLevels(db, user),
        }
      : null,
    summary: {
      totalUsuarios: users.length,
      totalDocentes: users.filter((u) => u.role === 'docente').length,
      totalEstudiantes: users.filter((u) => u.role === 'estudiante').length,
      totalSedes: locations.length,
      totalGrupos: db.academicGroups.filter((g) => g.companyId === companyId).length,
      totalAsignaturas: db.subjects.filter((s) => s.companyId === companyId).length,
    },
    users,
    locations,
  })
})
