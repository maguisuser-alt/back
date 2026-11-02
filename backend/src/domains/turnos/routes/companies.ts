import { Router } from 'express'
import { resolveAllowedModules, resolveCompanyIdForUser } from '../lib/access.js'
import { readDatabase } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const companiesRouter = Router()

companiesRouter.use(requireAuth)

companiesRouter.get('/me', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const company = db.companies.find(
    (item) => item.id === companyId,
  )

  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  response.json(company)
})

companiesRouter.get('/summary', requireRole(['admin']), async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const summary = {
    empresa: db.companies.find((company) => company.id === companyId),
    totalUsuarios: db.users.filter((user) => user.companyId === companyId).length,
    totalPuestos: db.positions.filter((position) => position.companyId === companyId)
      .length,
    totalTurnos: db.turns.filter((turn) => turn.companyId === companyId).length,
  }

  response.json(summary)
})

companiesRouter.get('/management', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((item) => item.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)

  const company = db.companies.find((item) => item.id === companyId) ?? null
  const positions = db.positions.filter((item) => item.companyId === companyId)
  const users = db.users.filter((item) => item.companyId === companyId)
  const locations = db.locations.filter((item) => item.companyId === companyId)
  const invitations = db.userInvitations
    .filter((item) => item.companyId === companyId)
    .map((item) => ({
      ...item,
      invitePath: `/registro-integrante/${item.token}`,
    }))
  const turns = db.turns.filter((item) => item.companyId === companyId)

  response.json({
    company,
    currentUser: currentUser
      ? {
          id: currentUser.id,
          companyId,
          role: currentUser.role,
          positionId: currentUser.positionId,
          allowedModules: resolveAllowedModules(db, currentUser),
        }
      : null,
    summary: {
      totalUsuarios: users.length,
      totalPuestos: positions.length,
      totalUbicaciones: locations.length,
      totalInvitaciones: invitations.length,
      totalTurnos: turns.length,
    },
    positions,
    users,
    locations,
    invitations,
    turns,
  })
})
