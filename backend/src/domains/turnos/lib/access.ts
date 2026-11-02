import type { Request, Response, NextFunction } from 'express'
import type { AccessModule, CompanySettings, CompanyType, DatabaseSchema, PermissionLevel, User } from '../types.js'
import { defaultPermissionsByRole } from '../types.js'
import { readDatabase } from './database.js'

// ── Módulos por defecto según tipo de gestión ──────────────────────────

export const empresaModules: AccessModule[] = [
  'dashboard',
  'turnos-fijos',
  'turnos-rotativos',
  'horas-extras-recargos',
  'geolocalizacion',
  'permisos-ausencias',
  'biometria-facial',
  'facturacion',
  'informes',
  'configuracion',
  'whatsapp-turnos',
]

export const academiaModules: AccessModule[] = [
  'dashboard',
  'asistencia-clase',
  'codigo-qr',
  'asistencia-docente',
  'porcentaje-asistencia',
  'justificaciones',
  'alertas-inasistencia',
  'eventos-talleres',
  'informes',
  'configuracion',
  'whatsapp-turnos',
]

export function getDefaultModulesByType(tipo: CompanyType): AccessModule[] {
  return tipo === 'academia' ? academiaModules : empresaModules
}

export function getDefaultSettings(tipo: CompanyType): CompanySettings {
  const base = {
    requireBiometric: true,
    requirePhoto: true,
    requireLocationValidation: true,
    allowAutoCloseMinutes: 30,
    defaultConfirmHoursLimit: 4,
    timezone: 'America/Bogota',
  }

  if (tipo === 'academia') {
    return {
      ...base,
      requireBiometric: false,
      requireLocationValidation: false,
      maxInasistenciaPorcentaje: 20,
      duracionBloque: 45,
      alertaFaltasConsecutivas: 3,
      requiereExcusaFormal: true,
      habilitarQrDinamico: true,
    }
  }

  return {
    ...base,
    billingRateDefault: undefined,
    recargoNocturno: 35,
    recargoDominical: 75,
    recargoFestivo: 100,
    jornadaOrdinaria: 8,
    permitirTeletrabajo: false,
    permitirPermutaTurnos: false,
  }
}

export function resolveCompanyIdForUser(db: DatabaseSchema, user: User | undefined) {
  if (!user) return ''
  return user.companyId || db.users.find((item) => item.id === user.id)?.companyId || ''
}

/**
 * Resuelve los módulos permitidos para un usuario según:
 * 1. Tipo de empresa (empresa vs academia)
 * 2. Rol del usuario (admin, supervisor, operativo, docente, estudiante)
 * 3. Permisos específicos del cargo (Position) si están definidos
 */
export function resolveAllowedModules(db: DatabaseSchema, user: User): AccessModule[] {
  const company = db.companies.find((c) => c.id === user.companyId)
  const companyType = company?.tipo ?? 'empresa'
  const companyModules = company?.enabledModules ?? getDefaultModulesByType(companyType)

  // Admin: todos los módulos habilitados de la empresa
  if (user.role === 'admin') {
    return companyModules
  }

  // Permisos específicos del cargo (si están definidos)
  const position = user.positionId
    ? db.positions.find((item) => item.id === user.positionId && item.companyId === user.companyId)
    : undefined

  if (position?.permissions?.length) {
    // Intersección: solo permisos del cargo que la empresa tiene habilitados
    const posResolved = position.permissions.filter((m) => companyModules.includes(m))

    // Módulos globales: siempre incluidos si la empresa los tiene
    const globalModules: AccessModule[] = ['trazabilidad']
    for (const gm of globalModules) {
      if (companyModules.includes(gm) && !posResolved.includes(gm)) {
        posResolved.push(gm)
      }
    }

    return posResolved
  }

  // Permisos por defecto del rol según tipo de empresa
  const roleDefaults = defaultPermissionsByRole[user.role]
  const defaults = companyType === 'academia' ? roleDefaults.academia : roleDefaults.empresa

  // Intersección con módulos habilitados de la empresa
  const resolved = defaults.filter((m) => companyModules.includes(m))

  // Módulos globales: si la empresa los tiene habilitados, todos los usuarios los ven
  const globalModules: AccessModule[] = ['trazabilidad']
  for (const gm of globalModules) {
    if (companyModules.includes(gm) && !resolved.includes(gm)) {
      resolved.push(gm)
    }
  }

  return resolved
}

/**
 * Resuelve los niveles de permiso (none/view/edit/full) para cada módulo del usuario.
 * - Admin: siempre 'full'
 * - Supervisor: 'edit' (puede aprobar/rechazar) 
 * - Operativo: 'view' (solo ver y marcar asistencia)
 * - Custom: según permissionLevels del cargo
 */
export function resolvePermissionLevels(db: DatabaseSchema, user: User): Record<string, PermissionLevel> {
  const modules = resolveAllowedModules(db, user)
  const levels: Record<string, PermissionLevel> = {}

  // Admin: full en todo
  if (user.role === 'admin') {
    for (const m of modules) levels[m] = 'full'
    return levels
  }

  // Si el cargo tiene permissionLevels definidos, usarlos
  const position = user.positionId
    ? db.positions.find((item) => item.id === user.positionId && item.companyId === user.companyId)
    : undefined

  const isSup = user.role === 'supervisor' || Boolean(user.cargo?.toLowerCase().includes('supervisor'))

  for (const m of modules) {
    if (position?.permissionLevels?.[m]) {
      levels[m] = position.permissionLevels[m] as PermissionLevel
    } else {
      // Defaults por rol:
      // - configuracion: solo admin tiene full
      // - geolocalizacion, permisos-ausencias: supervisor edit, otros view
      // - turnos-fijos, biometria-facial: todos al menos view
      if (m === 'configuracion') {
        levels[m] = 'view'
      } else if (['geolocalizacion', 'permisos-ausencias', 'horas-extras-recargos', 'facturacion'].includes(m)) {
        levels[m] = isSup ? 'edit' : 'view'
      } else if (['informes'].includes(m)) {
        levels[m] = 'view'
      } else {
        levels[m] = isSup ? 'edit' : 'view'
      }
    }
  }

  return levels
}

/**
 * Middleware: Restringe una ruta a un tipo específico de empresa (empresa / academia).
 * Usa el usuario autenticado para determinar la empresa.
 */
export function requireCompanyType(tipoRequerido: CompanyType) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const authUser = (request as any).authUser as { userId: string; companyId: string } | undefined
      if (!authUser) { next(); return }

      const db = await readDatabase()
      const user = db.users.find((u) => u.id === authUser.userId)
      const companyId = user?.companyId || authUser.companyId
      const company = db.companies.find((c) => c.id === companyId)

      if (company && company.tipo !== tipoRequerido) {
        // Si la empresa no es del tipo requerido, 403
        // (pero permitimos que los usuarios 'root' pasen)
        if ((request as any).authUser?.role !== 'root') {
          const err: any = new Error(`Esta funcionalidad solo está disponible para tipo de institución: ${tipoRequerido}.`)
          err.status = 403
          next(err)
          return
        }
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Determina el tipo de empresa del usuario autenticado.
 */
export async function resolveCompanyTypeForAuth(authUser: { userId: string; companyId: string }): Promise<CompanyType> {
  const db = await readDatabase()
  const user = db.users.find((u) => u.id === authUser.userId)
  const companyId = user?.companyId || authUser.companyId
  const company = db.companies.find((c) => c.id === companyId)
  return company?.tipo ?? 'empresa'
}
