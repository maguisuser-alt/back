/**
 * Reglas para administrar usuarios de una empresa (activar / desactivar) y
 * limpieza de datos sensibles antes de enviarlos al navegador.
 */
import type { AccessModule, User } from '../types.js'

/** Módulos que dan "opciones de admin" sobre los usuarios (por cargo). */
export const USER_ADMIN_MODULES: AccessModule[] = ['editar-empleados', 'eliminar-empleados']

/**
 * ¿Puede `actor` activar/desactivar usuarios de su empresa?
 * Sí si es admin, o si su cargo le da módulos de administración de empleados.
 */
export function canManageUsers(actor: Pick<User, 'role'>, allowedModules: readonly string[]): boolean {
  return actor.role === 'admin' || USER_ADMIN_MODULES.some((m) => allowedModules.includes(m))
}

export type StatusChangeCheck = { ok: true } | { ok: false; status: number; message: string }

/**
 * Valida un cambio de estado de `target` hecho por `actor`:
 *  - nadie se desactiva a sí mismo;
 *  - solo un admin puede cambiar el estado de otro admin;
 *  - no se puede desactivar al último admin activo de la empresa.
 * `activeAdmins` = admins activos de la empresa (incluye a `target` si lo es).
 */
export function checkStatusChange(params: {
  actor: Pick<User, 'id' | 'role'> | 'root'
  target: Pick<User, 'id' | 'role' | 'activa'>
  activa: boolean
  activeAdmins: number
}): StatusChangeCheck {
  const { actor, target, activa, activeAdmins } = params
  if (actor !== 'root') {
    if (actor.id === target.id) return { ok: false, status: 403, message: 'No puedes cambiar el estado de tu propia cuenta.' }
    if (target.role === 'admin' && actor.role !== 'admin') {
      return { ok: false, status: 403, message: 'Solo un administrador puede activar o desactivar a otro administrador.' }
    }
  }
  const targetIsActiveAdmin = target.role === 'admin' && target.activa !== false
  if (!activa && targetIsActiveAdmin && activeAdmins <= 1) {
    return { ok: false, status: 409, message: 'No se puede desactivar al único administrador activo de la empresa. Asigna otro administrador primero.' }
  }
  return { ok: true }
}

/**
 * Usuario sin datos sensibles: sin hash de contraseña, sin descriptores
 * faciales ni credenciales biométricas (antes viajaban completos a cualquier
 * usuario que abría la gestión). Se deja un resumen del estado biométrico.
 */
export function publicUser(u: User): Omit<User, 'passwordHash' | 'faceDescriptor' | 'biometric' | 'faceProfile'> & {
  tienePassword: boolean
  faceRegistered: boolean
  faceEstado?: string
} {
  const { passwordHash, faceDescriptor, biometric, faceProfile, ...rest } = u
  void biometric
  return {
    ...rest,
    activa: u.activa !== false,
    tienePassword: Boolean(passwordHash),
    faceRegistered: Boolean(faceDescriptor?.length || faceProfile?.faceDescriptors?.length),
    ...(faceProfile?.estado ? { faceEstado: faceProfile.estado } : {}),
  }
}
