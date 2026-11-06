import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { hashPassword, signToken } from '../lib/auth.js'
import { deleteCompany } from '../lib/database.js'
import { getCompaniesCollection, getUsersCollection, getDb } from '../lib/mongodb.js'
import { requireAuth, requireRoot } from '../middleware/auth.js'
import type { AccessModule, CompanySettings, CompanyType } from '../types.js'

export const rootRouter = Router()

const TRACER_API_URL = (process.env.TRACER_API_URL || '').replace(/\/$/, '')

async function syncTracerFeatures(companyId: string, settings: {
  sheetsEnabled?: boolean
  activityLog?: boolean; sendEmail?: boolean; emailTo?: string
  whatsappTrazabilidad?: boolean
  whatsappUnified?: boolean; whatsappAudio?: boolean; whatsappCatalog?: boolean
  whatsappDocument?: boolean; markerEditor?: boolean; registrarActividad?: boolean
  operationTypesLimit?: number
}, authHeader?: string) {
  if (!TRACER_API_URL) {
    console.warn('[root] TRACER_API_URL no configurado: no se sincronizarán las features de trazabilidad con el backend del tracer.')
    return
  }
  try {
    // El endpoint del tracer está protegido con `requireToken`. Si no reenviamos
    // el token del root, responde 401 y los cambios de configuración se guardan
    // solo en la empresa (BD de turnos) pero NUNCA llegan a trazabilidad, por lo
    // que la app seguía mostrando la configuración anterior.
    const res = await fetch(`${TRACER_API_URL}/settings/features`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({ companyId, ...settings, source: 'root' }),
    })
    if (!res.ok) {
      console.error(`[root] Sincronización de features fallida (${res.status}): ${await res.text().catch(() => res.statusText)}`)
    }
  } catch (err) {
    console.error('[root] No se pudo sincronizar features con el tracer:', err)
  }
}

// ── Credenciales root ───────────────────────────────────────────────────────
// Se leen de ROOT_USERNAME / ROOT_PASSWORD (Render → Environment).
// TRANSICIÓN: si ROOT_PASSWORD no está definida se usa el valor histórico para no
// cortar el acceso; en cuanto la definas, el valor del código deja de usarse.
const ROOT_USERNAME = process.env.ROOT_USERNAME || 'root'
const ROOT_PASSWORD = process.env.ROOT_PASSWORD || '1192920673J'
if (!process.env.ROOT_PASSWORD) {
  console.warn('[turnos/root] ROOT_PASSWORD no está definida: se usa la contraseña histórica del código. Defínela en Render y rótala.')
}

/** Comparación en tiempo constante para no filtrar información por tiempos de respuesta. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ── POST /api/root/login ────────────────────────────────────────────────────
rootRouter.post('/login', (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string }

  if (!username || !password) {
    response.status(400).json({ message: 'Username y password son requeridos.' })
    return
  }

  if (!safeEqual(username, ROOT_USERNAME) || !safeEqual(password, ROOT_PASSWORD)) {
    response.status(401).json({ message: 'Credenciales root inválidas.' })
    return
  }

  const token = signToken({
    userId: 'root',
    companyId: 'root',
    role: 'root',
  })

  response.json({ token, user: { role: 'root', username: 'root' } })
})

// ── Todas las rutas siguientes requieren autenticación root ─────────────────
rootRouter.use(requireAuth, requireRoot)

// ── GET /api/root/companies ─────────────────────────────────────────────────
rootRouter.get('/companies', async (_request, response) => {
  const companiesCol = await getCompaniesCollection()
  const usersCol = await getUsersCollection()

  const companies = await companiesCol.find({}).toArray()

  const companiesWithStats = await Promise.all(
    companies.map(async (company) => {
      const adminCount = await usersCol.countDocuments({ companyId: company.id, role: 'admin' })
      const employeeCount = await usersCol.countDocuments({ companyId: company.id })

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
        trazabilidadSettings: company.settings?.trazabilidadSettings,
        adminCount,
        employeeCount,
        createdAt: company.createdAt,
      }
    }),
  )

  response.json(companiesWithStats)
})

// ── PATCH /api/root/companies/:companyId ────────────────────────────────────
rootRouter.patch('/companies/:companyId', async (request, response) => {
  const { companyId } = request.params
  const { activa, nombre, nit, correo, telefono, direccion, ciudad, tipo } = request.body as {
    activa?: boolean
    nombre?: string
    nit?: string
    correo?: string
    telefono?: string
    direccion?: string
    ciudad?: string
    tipo?: CompanyType
  }

  const update: Record<string, unknown> = {}

  if (typeof activa === 'boolean') update.activa = activa
  if (typeof nombre === 'string' && nombre.trim()) update.nombre = nombre.trim()
  if (typeof nit === 'string' && nit.trim()) update.nit = nit.trim()
  if (typeof correo === 'string' && correo.trim()) update.correo = correo.trim()
  if (typeof telefono === 'string') update.telefono = telefono.trim()
  if (typeof direccion === 'string') update.direccion = direccion.trim()
  if (typeof ciudad === 'string') update.ciudad = ciudad.trim()
  if (tipo === 'empresa' || tipo === 'academia') update.tipo = tipo

  if (Object.keys(update).length === 0) {
    response.status(400).json({ message: 'Envía al menos un campo válido para actualizar la empresa.' })
    return
  }

  const companiesCol = await getCompaniesCollection()
  const currentCompany = await companiesCol.findOne({ id: companyId })
  if (!currentCompany) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  if (typeof update.nit === 'string' && update.nit !== currentCompany.nit) {
    const existing = await companiesCol.findOne({ nit: update.nit, id: { $ne: companyId } as any })
    if (existing) {
      response.status(409).json({ message: 'Ya existe otra empresa con ese NIT.' })
      return
    }
  }

  const result = await companiesCol.updateOne(
    { id: companyId },
    { $set: update },
  )

  if (result.matchedCount === 0) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  response.json({
    message: typeof activa === 'boolean'
      ? `Empresa ${activa ? 'activada' : 'desactivada'} correctamente.`
      : 'Empresa actualizada correctamente.',
    company: {
      ...currentCompany,
      ...update,
    },
  })
})

// ── POST /api/root/companies/:companyId/assign-admin ────────────────────────
rootRouter.post('/companies/:companyId/assign-admin', async (request, response) => {
  const { companyId } = request.params
  const { userId } = request.body as { userId?: string }

  if (!userId) {
    response.status(400).json({ message: 'El campo "userId" es requerido.' })
    return
  }

  const companiesCol = await getCompaniesCollection()
  const usersCol = await getUsersCollection()

  const company = await companiesCol.findOne({ id: companyId })
  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  const user = await usersCol.findOne({ id: userId })
  if (!user) {
    response.status(404).json({ message: 'Usuario no encontrado.' })
    return
  }

  await usersCol.updateOne(
    { id: userId },
    { $set: { companyId, role: 'admin' } },
  )

  response.json({ message: `Usuario ${user.nombreCompleto} asignado como admin de ${company.nombre}.` })
})

// ── POST /api/root/companies — crear empresa (sin admin) ────────────────────
rootRouter.post('/companies', async (request, response) => {
  const body = request.body as {
    nombre?: string
    nit?: string
    correo?: string
    telefono?: string
    direccion?: string
    ciudad?: string
    tipo?: CompanyType
  }

  if (!body.nombre || !body.nit || !body.correo) {
    response.status(400).json({ message: 'nombre, nit y correo son requeridos.' })
    return
  }

  const companiesCol = await getCompaniesCollection()

  // Verificar NIT duplicado
  const existing = await companiesCol.findOne({ nit: body.nit })
  if (existing) {
    response.status(409).json({ message: 'Ya existe una empresa con ese NIT.' })
    return
  }

  const tipo: CompanyType = body.tipo ?? 'empresa'

  const defaultModules: AccessModule[] = tipo === 'empresa'
    ? ['dashboard', 'turnos-fijos', 'turnos-rotativos', 'horas-extras-recargos', 'geolocalizacion', 'permisos-ausencias', 'biometria-facial', 'teletrabajo', 'facturacion', 'informes', 'configuracion', 'whatsapp-turnos']
    : ['dashboard', 'asistencia-clase', 'codigo-qr', 'asistencia-docente', 'porcentaje-asistencia', 'justificaciones', 'alertas-inasistencia', 'eventos-talleres', 'informes', 'configuracion', 'whatsapp-turnos']

  const defaultSettings: CompanySettings = {
    requireBiometric: true,
    requirePhoto: true,
    requireLocationValidation: true,
    allowAutoCloseMinutes: 480,
    defaultConfirmHoursLimit: 4,
    timezone: 'America/Bogota',
  }

  const newCompany = {
    id: `comp-${Date.now()}`,
    nombre: body.nombre,
    nit: body.nit,
    correo: body.correo,
    telefono: body.telefono,
    direccion: body.direccion,
    ciudad: body.ciudad,
    tipo,
    enabledModules: defaultModules,
    settings: defaultSettings,
    activa: true,
    createdAt: new Date().toISOString(),
  }

  await companiesCol.insertOne(newCompany as any)

  response.status(201).json(newCompany)
})

// ── PATCH /api/root/companies/:companyId/modules ────────────────────────────
// Habilita o deshabilita módulos específicos para una empresa.
// Body: { enabledModules: AccessModule[], trazabilidadSettings?: { activityLog?, sendEmail?, emailTo? } }
rootRouter.patch('/companies/:companyId/modules', async (request, response) => {
  const { companyId } = request.params
  const { enabledModules, trazabilidadSettings } = request.body as {
    enabledModules?: AccessModule[]
    trazabilidadSettings?: {
      sheetsEnabled?: boolean
      activityLog?: boolean
      sendEmail?: boolean
      emailTo?: string
      whatsappTrazabilidad?: boolean
      whatsappUnified?: boolean
      whatsappAudio?: boolean
      whatsappCatalog?: boolean
      whatsappDocument?: boolean
      markerEditor?: boolean
      registrarActividad?: boolean
      mfeEnabled?: boolean
      mfeExposeComponents?: boolean
      mfeEventBus?: boolean
      mfeDisableSharedPermissions?: boolean
      operationTypesLimit?: number
    }
  }

  if (!Array.isArray(enabledModules)) {
    response.status(400).json({ message: 'enabledModules (array) es requerido.' })
    return
  }

  const companiesCol = await getCompaniesCollection()

  const update: Record<string, unknown> = { enabledModules }
  if (trazabilidadSettings && typeof trazabilidadSettings === 'object') {
    const opLimitRaw = trazabilidadSettings.operationTypesLimit
    const operationTypesLimit = typeof opLimitRaw === 'number' && opLimitRaw >= 0
      ? Math.round(opLimitRaw)
      : 0
    update['settings.trazabilidadSettings'] = {
      sheetsEnabled: Boolean(trazabilidadSettings.sheetsEnabled),
      activityLog: Boolean(trazabilidadSettings.activityLog),
      sendEmail: Boolean(trazabilidadSettings.sendEmail),
      emailTo: (trazabilidadSettings.emailTo ?? '').trim(),
      whatsappTrazabilidad: Boolean(trazabilidadSettings.whatsappTrazabilidad),
      whatsappUnified: Boolean(trazabilidadSettings.whatsappUnified),
      whatsappAudio: Boolean(trazabilidadSettings.whatsappAudio),
      whatsappCatalog: Boolean(trazabilidadSettings.whatsappCatalog),
      whatsappDocument: Boolean(trazabilidadSettings.whatsappDocument),
      markerEditor: Boolean(trazabilidadSettings.markerEditor),
      registrarActividad: Boolean(trazabilidadSettings.registrarActividad),
      mfeEnabled: Boolean(trazabilidadSettings.mfeEnabled),
      mfeExposeComponents: Boolean(trazabilidadSettings.mfeExposeComponents),
      mfeEventBus: Boolean(trazabilidadSettings.mfeEventBus),
      mfeDisableSharedPermissions: Boolean(trazabilidadSettings.mfeDisableSharedPermissions),
      operationTypesLimit,
    }
  }

  const result = await companiesCol.updateOne(
    { id: companyId },
    { $set: update },
  )

  if (result.matchedCount === 0) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  if (trazabilidadSettings && typeof trazabilidadSettings === 'object') {
    void syncTracerFeatures(companyId, update['settings.trazabilidadSettings'] as any, request.headers.authorization)
  }

  response.json({ message: 'Módulos actualizados correctamente.', enabledModules, trazabilidadSettings: update['settings.trazabilidadSettings'] })
})

// ── GET /api/root/companies/:companyId/users ────────────────────────────────
// Lista los empleados/usuarios de una empresa (contexto root).
rootRouter.get('/companies/:companyId/users', async (request, response) => {
  const { companyId } = request.params

  const companiesCol = await getCompaniesCollection()
  const company = await companiesCol.findOne({ id: companyId })
  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  const usersCol = await getUsersCollection()
  const users = await usersCol.find({ companyId }).toArray()

  const list = users.map((u) => ({
    id: u.id,
    nombreCompleto: u.nombreCompleto,
    tipoDocumento: u.tipoDocumento,
    numeroDocumento: u.numeroDocumento,
    correo: u.correo,
    telefono: u.telefono,
    cargo: u.cargo,
    role: u.role,
    activa: u.activa ?? true,
    tienePassword: Boolean(u.passwordHash),
    createdAt: u.createdAt,
  }))

  response.json(list)
})

// ── DELETE /api/root/companies/:companyId/users/:userId ─────────────────────
// Elimina un empleado de una empresa (contexto root).
rootRouter.delete('/companies/:companyId/users/:userId', async (request, response) => {
  const { companyId, userId } = request.params

  const usersCol = await getUsersCollection()
  const user = await usersCol.findOne({ id: userId, companyId })
  if (!user) {
    response.status(404).json({ message: 'Empleado no encontrado en esta empresa.' })
    return
  }

  await usersCol.deleteOne({ id: userId })
  response.json({ message: `Empleado ${user.nombreCompleto} eliminado.` })
})

// ── POST /api/root/companies/:companyId/users/:userId/reset-password ─────────
// Restaura/cambia la contraseña de acceso de un empleado (hash bcrypt).
// Body: { password: string }
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
    response.status(404).json({ message: 'Empleado no encontrado en esta empresa.' })
    return
  }

  const passwordHash = await hashPassword(password.trim())
  await usersCol.updateOne({ id: userId }, { $set: { passwordHash } })

  response.json({ message: `Contraseña actualizada para ${user.nombreCompleto}.` })
})

// ── DELETE /api/root/companies/:companyId ───────────────────────────────────
// Elimina una empresa y todos sus datos asociados en cascada (contexto root).
rootRouter.delete('/companies/:companyId', async (request, response) => {
  const { companyId } = request.params

  const companiesCol = await getCompaniesCollection()
  const company = await companiesCol.findOne({ id: companyId })
  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  await deleteCompany(companyId)
  response.json({ message: `Empresa ${company.nombre} y sus datos asociados fueron eliminados.` })
})

// ── Registro de Microfrontends (config por compañía) ────────────────────────
// Persiste en el backend del Host (turnos) el registro de MFEs y su
// configuración por compañía, para compartirlo entre usuarios/dispositivos.
// Cada producto mantiene su backend independiente; esto es solo el registro del
// portal. La config llega a cada MFE a través de la identidad del usuario.
const MFE_DOC_ID = 'registry'

// GET /api/root/mfe-config → { mfes: [...] }
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

// PUT /api/root/mfe-config  Body: { mfes: [...] }
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
