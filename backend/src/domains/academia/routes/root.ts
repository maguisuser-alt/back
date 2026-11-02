import { Router } from 'express'
import { academiaModules, getDefaultSettings } from '../lib/access.js'
import { hashPassword, signToken } from '../lib/auth.js'
import { deleteCompany } from '../lib/database.js'
import { getCompaniesCollection, getUsersCollection, getDb } from '../lib/mongodb.js'
import { requireAuth, requireRoot } from '../middleware/auth.js'
import type { AccessModule } from '../types.js'

export const rootRouter = Router()

// ── Credenciales root ───────────────────────────────────────────────────────
const ROOT_USERNAME = process.env.ROOT_USERNAME ?? 'root'
const ROOT_PASSWORD = process.env.ROOT_PASSWORD ?? '1192920673J'

// ── POST /api/root/login ────────────────────────────────────────────────────
rootRouter.post('/login', (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string }
  if (!username || !password) {
    response.status(400).json({ message: 'Usuario y contraseña son requeridos.' })
    return
  }
  if (username !== ROOT_USERNAME || password !== ROOT_PASSWORD) {
    response.status(401).json({ message: 'Credenciales root inválidas.' })
    return
  }
  const token = signToken({ userId: 'root', companyId: 'root', role: 'root' })
  response.json({ token, user: { role: 'root', username: 'root' } })
})

// ── A partir de aquí, todo requiere root ────────────────────────────────────
rootRouter.use(requireAuth, requireRoot)

// ── GET /api/root/companies ─────────────────────────────────────────────────
rootRouter.get('/companies', async (_request, response) => {
  const companiesCol = await getCompaniesCollection()
  const usersCol = await getUsersCollection()
  const companies = await companiesCol.find({}).project({ _id: 0 }).toArray()

  const list = await Promise.all(
    companies.map(async (company: any) => {
      const adminCount = await usersCol.countDocuments({ companyId: company.id, role: 'admin' })
      const docenteCount = await usersCol.countDocuments({ companyId: company.id, role: 'docente' })
      const estudianteCount = await usersCol.countDocuments({ companyId: company.id, role: 'estudiante' })
      return {
        id: company.id,
        nombre: company.nombre,
        nit: company.nit,
        correo: company.correo,
        telefono: company.telefono,
        direccion: company.direccion,
        ciudad: company.ciudad,
        tipo: company.tipo,
        activa: company.activa ?? true,
        enabledModules: company.enabledModules,
        adminCount,
        docenteCount,
        estudianteCount,
        createdAt: company.createdAt,
      }
    }),
  )
  response.json(list)
})

// ── POST /api/root/companies — crear institución (sin admin) ────────────────
rootRouter.post('/companies', async (request, response) => {
  const body = request.body as {
    nombre?: string; nit?: string; correo?: string
    telefono?: string; direccion?: string; ciudad?: string
  }
  if (!body.nombre || !body.nit || !body.correo) {
    response.status(400).json({ message: 'nombre, nit y correo son requeridos.' })
    return
  }

  const companiesCol = await getCompaniesCollection()
  const existing = await companiesCol.findOne({ nit: body.nit })
  if (existing) {
    response.status(409).json({ message: 'Ya existe una institución con ese NIT.' })
    return
  }

  const newCompany = {
    id: `company-${Date.now()}`,
    nombre: body.nombre,
    nit: body.nit,
    correo: body.correo,
    telefono: body.telefono,
    direccion: body.direccion,
    ciudad: body.ciudad,
    tipo: 'academia' as const,
    enabledModules: [...academiaModules],
    settings: getDefaultSettings(),
    activa: true,
    createdAt: new Date().toISOString(),
  }
  await companiesCol.insertOne(newCompany as any)
  response.status(201).json(newCompany)
})

// ── PATCH /api/root/companies/:companyId — activar/desactivar ───────────────
rootRouter.patch('/companies/:companyId', async (request, response) => {
  const { companyId } = request.params
  const { activa } = request.body as { activa?: boolean }
  if (typeof activa !== 'boolean') {
    response.status(400).json({ message: 'El campo "activa" (boolean) es requerido.' })
    return
  }
  const companiesCol = await getCompaniesCollection()
  const result = await companiesCol.updateOne({ id: companyId }, { $set: { activa } })
  if (result.matchedCount === 0) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  response.json({ message: `Institución ${activa ? 'activada' : 'desactivada'} correctamente.`, activa })
})

// ── PATCH /api/root/companies/:companyId/modules — habilita/quita módulos ───
rootRouter.patch('/companies/:companyId/modules', async (request, response) => {
  const { companyId } = request.params
  const { enabledModules } = request.body as { enabledModules?: AccessModule[] }
  if (!Array.isArray(enabledModules)) {
    response.status(400).json({ message: 'enabledModules (array) es requerido.' })
    return
  }
  // Solo acepta módulos válidos del catálogo académico; 'dashboard' siempre presente.
  const valid = enabledModules.filter((m) => academiaModules.includes(m))
  if (!valid.includes('dashboard')) valid.unshift('dashboard')

  const companiesCol = await getCompaniesCollection()
  const result = await companiesCol.updateOne({ id: companyId }, { $set: { enabledModules: valid } })
  if (result.matchedCount === 0) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  response.json({ message: 'Módulos actualizados correctamente.', enabledModules: valid })
})

// ── GET /api/root/companies/:companyId/users ────────────────────────────────
rootRouter.get('/companies/:companyId/users', async (request, response) => {
  const { companyId } = request.params
  const companiesCol = await getCompaniesCollection()
  const company = await companiesCol.findOne({ id: companyId })
  if (!company) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  const usersCol = await getUsersCollection()
  const users = await usersCol.find({ companyId }).project({ _id: 0 }).toArray()
  const list = users.map((u: any) => ({
    id: u.id,
    nombreCompleto: u.nombreCompleto,
    tipoDocumento: u.tipoDocumento,
    numeroDocumento: u.numeroDocumento,
    correo: u.correo,
    telefono: u.telefono,
    cargo: u.cargo,
    role: u.role,
    activa: u.activa ?? true,
    createdAt: u.createdAt,
  }))
  response.json(list)
})

// ── DELETE /api/root/companies/:companyId/users/:userId ─────────────────────
rootRouter.delete('/companies/:companyId/users/:userId', async (request, response) => {
  const { companyId, userId } = request.params
  const usersCol = await getUsersCollection()
  const user = await usersCol.findOne({ id: userId, companyId })
  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado en esta institución.' })
    return
  }
  await usersCol.deleteOne({ id: userId })
  response.json({ message: `Usuario ${(user as any).nombreCompleto} eliminado.` })
})

// ── POST /api/root/companies/:companyId/users/:userId/reset-password ────────
rootRouter.post('/companies/:companyId/users/:userId/reset-password', async (request, response) => {
  const { companyId, userId } = request.params
  const { password } = request.body as { password?: string }
  if (!password || password.trim().length < 4) {
    response.status(400).json({ message: 'La contraseña debe tener al menos 4 caracteres.' })
    return
  }
  const usersCol = await getUsersCollection()
  const user = await usersCol.findOne({ id: userId, companyId })
  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado en esta institución.' })
    return
  }
  const passwordHash = await hashPassword(password.trim())
  await usersCol.updateOne({ id: userId }, { $set: { passwordHash } })
  response.json({ message: `Contraseña actualizada para ${(user as any).nombreCompleto}.` })
})

// ── DELETE /api/root/companies/:companyId — eliminar institución en cascada ─
rootRouter.delete('/companies/:companyId', async (request, response) => {
  const { companyId } = request.params
  const companiesCol = await getCompaniesCollection()
  const company = await companiesCol.findOne({ id: companyId })
  if (!company) {
    response.status(404).json({ message: 'Institución no encontrada.' })
    return
  }
  await deleteCompany(companyId)
  response.json({ message: `Institución ${(company as any).nombre} y sus datos asociados fueron eliminados.` })
})

// ── Registro de Microfrontends (config por compañía) ────────────────────────
// Persiste el registro de MFEs del portal de academia en su propio backend.
const MFE_DOC_ID = 'registry'

rootRouter.get('/mfe-config', async (_request, response) => {
  try {
    const db = await getDb()
    const doc = await db.collection('mfe_config').findOne({ _id: MFE_DOC_ID as never })
    response.json({ mfes: (doc?.mfes as unknown[]) ?? [] })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    response.status(500).json({ message: 'Error al leer la configuración de microfrontends.', detail: message })
  }
})

rootRouter.put('/mfe-config', async (request, response) => {
  const { mfes } = request.body as { mfes?: unknown[] }
  if (!Array.isArray(mfes)) {
    response.status(400).json({ message: 'El cuerpo debe incluir un arreglo `mfes`.' })
    return
  }
  try {
    const db = await getDb()
    await db.collection('mfe_config').updateOne(
      { _id: MFE_DOC_ID as never },
      { $set: { mfes, updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    response.json({ message: 'Configuración de microfrontends guardada.', count: mfes.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    response.status(500).json({ message: 'Error al guardar la configuración de microfrontends.', detail: message })
  }
})
