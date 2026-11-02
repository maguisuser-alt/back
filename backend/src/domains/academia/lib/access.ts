import type { NextFunction, Request, Response } from 'express'
import type {
  AccessModule,
  CompanySettings,
  DatabaseSchema,
  PermissionLevel,
  User,
} from '../types.js'

/** Catálogo completo de módulos académicos. */
export const academiaModules: AccessModule[] = [
  'dashboard',
  'asistencia-clase',
  'codigo-qr',
  'asistencia-docente',
  'porcentaje-asistencia',
  'justificaciones',
  'alertas-inasistencia',
  'eventos-talleres',
  'gestionar-cursos',
  'gestionar-asignaturas',
  'gestionar-grupos-academicos',
  'confirmar-asistencia-clase',
  'registrar-ingreso',
  'validar-ingresos',
  'informes',
  'configuracion',
]

export const defaultPermissionsByRole: Record<string, AccessModule[]> = {
  admin: academiaModules,
  supervisor: ['dashboard', 'asistencia-clase', 'asistencia-docente', 'informes', 'validar-ingresos'],
  docente: ['dashboard', 'asistencia-clase', 'codigo-qr', 'porcentaje-asistencia', 'justificaciones', 'eventos-talleres', 'confirmar-asistencia-clase'],
  estudiante: ['dashboard', 'codigo-qr', 'porcentaje-asistencia', 'justificaciones', 'registrar-ingreso'],
}

export function getDefaultModulesByType(): AccessModule[] {
  return academiaModules
}

export function getDefaultSettings(): CompanySettings {
  return {
    requireBiometric: false,
    requirePhoto: true,
    requireLocationValidation: false,
    timezone: 'America/Bogota',
    toleranciaIngresoMin: 15,
    maxInasistenciaPorcentaje: 20,
    duracionBloque: 45,
    alertaFaltasConsecutivas: 3,
    requiereExcusaFormal: true,
    habilitarQrDinamico: true,
  }
}

export function resolveCompanyIdForUser(db: DatabaseSchema, user: User | undefined) {
  if (!user) return ''
  return user.companyId || db.users.find((item) => item.id === user.id)?.companyId || ''
}

/**
 * Resuelve los módulos permitidos para un usuario según el rol y los módulos
 * habilitados por la institución.
 */
export function resolveAllowedModules(db: DatabaseSchema, user: User): AccessModule[] {
  const company = db.companies.find((c) => c.id === user.companyId)
  const companyModules = company?.enabledModules ?? academiaModules

  if (user.role === 'admin') return companyModules

  const defaults = defaultPermissionsByRole[user.role] ?? ['dashboard']
  return defaults.filter((m) => companyModules.includes(m))
}

export function resolvePermissionLevels(db: DatabaseSchema, user: User): Record<string, PermissionLevel> {
  const modules = resolveAllowedModules(db, user)
  const levels: Record<string, PermissionLevel> = {}

  if (user.role === 'admin') {
    for (const m of modules) levels[m] = 'full'
    return levels
  }

  const isSup = user.role === 'supervisor'
  for (const m of modules) {
    if (m === 'configuracion') levels[m] = 'view'
    else if (m === 'informes') levels[m] = 'view'
    else levels[m] = isSup ? 'edit' : 'view'
  }
  return levels
}

/**
 * Middleware heredado de la versión multi-tipo. En este producto TODAS las
 * instituciones son academia, por lo que simplemente deja pasar.
 */
export function requireCompanyType(_tipoRequerido: 'academia') {
  return (_request: Request, _response: Response, next: NextFunction) => {
    next()
  }
}
