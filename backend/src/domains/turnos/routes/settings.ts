import { Router } from 'express'
import { resolveCompanyIdForUser } from '../lib/access.js'
import { readDatabase, updateCompany } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import type { AccessModule, CompanySettings } from '../types.js'

export const settingsRouter = Router()

settingsRouter.use(requireAuth, requireRole(['admin']))

/**
 * GET /settings — devuelve la configuración actual de la empresa
 */
settingsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const company = db.companies.find((c) => c.id === companyId)

  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  response.json({
    tipo: company.tipo,
    enabledModules: company.enabledModules,
    settings: company.settings,
  })
})

/**
 * PATCH /settings — actualiza la configuración de la empresa
 * Body: { settings?: Partial<CompanySettings>, enabledModules?: AccessModule[] }
 */
settingsRouter.patch('/', async (request, response) => {
  const { settings, enabledModules } = request.body ?? {}

  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const company = db.companies.find((c) => c.id === companyId)

  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  // Merge settings parcial — solo actualiza los campos enviados
  if (settings && typeof settings === 'object') {
    company.settings = { ...company.settings, ...settings } as CompanySettings
  }

  // Actualizar módulos habilitados
  if (Array.isArray(enabledModules) && enabledModules.length > 0) {
    company.enabledModules = enabledModules.filter(
      (m): m is AccessModule => typeof m === 'string'
    )
  }

  await updateCompany(company)

  response.json({
    message: 'Configuración actualizada correctamente.',
    tipo: company.tipo,
    enabledModules: company.enabledModules,
    settings: company.settings,
  })
})

/**
 * GET /settings/modules-available — lista todos los módulos disponibles según el tipo
 */
settingsRouter.get('/modules-available', async (request, response) => {
  const db = await readDatabase()
  const currentUser = db.users.find((u) => u.id === request.authUser!.userId)
  const companyId = resolveCompanyIdForUser(db, currentUser)
  const company = db.companies.find((c) => c.id === companyId)

  if (!company) {
    response.status(404).json({ message: 'Empresa no encontrada.' })
    return
  }

  const empresaModules = [
    { id: 'dashboard', label: 'Inicio', description: 'Vista principal con resumen.' },
    { id: 'turnos-fijos', label: 'Turnos fijos', description: 'Control de entradas y salidas en horarios rígidos.' },
    { id: 'turnos-rotativos', label: 'Turnos rotativos', description: 'Asignación dinámica mañana/tarde/noche.' },
    { id: 'horas-extras-recargos', label: 'Horas extras y recargos', description: 'Recargos nocturnos, dominicales y festivos.' },
    { id: 'geolocalizacion', label: 'Geolocalización', description: 'Validación GPS contra puntos de operación.' },
    { id: 'permisos-ausencias', label: 'Permisos y ausencias', description: 'Licencias, vacaciones e incapacidades.' },
    { id: 'biometria-facial', label: 'Biometría / facial', description: 'Registro con WebAuthn o foto facial.' },
    { id: 'teletrabajo', label: 'Teletrabajo', description: 'Fichaje virtual desde cualquier lugar.' },
    { id: 'facturacion', label: 'Facturación', description: 'Cuentas de cobro con desglose por tipo de día.' },
    { id: 'informes', label: 'Informes', description: 'Reportes exportables.' },
    { id: 'configuracion', label: 'Configuración', description: 'Gestión de cargos, ubicaciones y usuarios.' },
  ]

  const academiaModules = [
    { id: 'dashboard', label: 'Inicio', description: 'Vista principal con resumen.' },
    { id: 'asistencia-clase', label: 'Asistencia por clase', description: 'Pase de lista por asignatura.' },
    { id: 'codigo-qr', label: 'Código QR', description: 'QR dinámico para confirmar presencia.' },
    { id: 'asistencia-docente', label: 'Asistencia docente', description: 'Verificación de horas cátedra.' },
    { id: 'porcentaje-asistencia', label: '% mínimo asistencia', description: 'Control de faltas para aprobación.' },
    { id: 'justificaciones', label: 'Justificaciones', description: 'Excusas médicas o institucionales.' },
    { id: 'alertas-inasistencia', label: 'Alertas inasistencia', description: 'Notificaciones por faltas consecutivas.' },
    { id: 'eventos-talleres', label: 'Eventos y talleres', description: 'Actividades extracurriculares.' },
    { id: 'informes', label: 'Informes', description: 'Reportes académicos.' },
    { id: 'configuracion', label: 'Configuración', description: 'Materias, horarios, sedes.' },
  ]

  const availableRoles = company.tipo === 'academia'
    ? [
        { id: 'admin', label: 'Administrador', description: 'Acceso total a la plataforma.' },
        { id: 'docente', label: 'Docente', description: 'Gestiona asistencia de clases y calificaciones.' },
        { id: 'estudiante', label: 'Estudiante', description: 'Registra asistencia y consulta su estado.' },
      ]
    : [
        { id: 'admin', label: 'Administrador', description: 'Acceso total a la plataforma.' },
        { id: 'supervisor', label: 'Supervisor', description: 'Confirma asistencia del equipo operativo.' },
        { id: 'operativo', label: 'Operativo', description: 'Marca asistencia y consulta sus turnos.' },
      ]

  response.json({
    tipo: company.tipo,
    modules: company.tipo === 'academia' ? academiaModules : empresaModules,
    enabled: company.enabledModules,
    roles: availableRoles,
  })
})
