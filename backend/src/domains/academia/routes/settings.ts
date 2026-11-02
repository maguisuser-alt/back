import { Router } from 'express'
import { readDatabase, updateCompany } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { CompanySettings } from '../types.js'

export const settingsRouter = Router()
settingsRouter.use(requireAuth)

/** GET /api/settings — configuración de la institución. */
settingsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = user?.companyId || request.authUser!.companyId
  const company = db.companies.find((c) => c.id === companyId)
  if (!company) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  response.json({ settings: company.settings, enabledModules: company.enabledModules ?? [] })
})

/** PATCH /api/settings — actualiza la configuración (solo admin). */
settingsRouter.patch('/', requireRole(['admin']), async (request, response) => {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = user?.companyId || request.authUser!.companyId
  const company = db.companies.find((c) => c.id === companyId)
  if (!company) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }

  const patch = (request.body ?? {}) as Partial<CompanySettings>
  const allowed: (keyof CompanySettings)[] = [
    'requireBiometric', 'requirePhoto', 'requireLocationValidation', 'timezone',
    'toleranciaIngresoMin', 'maxInasistenciaPorcentaje', 'duracionBloque',
    'alertaFaltasConsecutivas', 'requiereExcusaFormal', 'habilitarQrDinamico',
  ]
  const next: CompanySettings = { ...company.settings }
  for (const key of allowed) {
    if (patch[key] !== undefined) (next as any)[key] = patch[key]
  }
  company.settings = next
  await updateCompany(company)
  response.json({ settings: company.settings })
})
