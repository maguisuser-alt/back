import type { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../lib/auth.js'
import { getCompaniesCollection, getUsersCollection } from '../lib/mongodb.js'
import type { AuthUser, UserRole } from '../types.js'

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser
      /** True si el usuario es supervisor (por rol O por cargo). Se resuelve la primera vez que se necesita. */
      _resolvedSupervisor?: boolean
    }
  }
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  const authorization = request.headers.authorization

  if (!authorization?.startsWith('Bearer ')) {
    response.status(401).json({ message: 'Token requerido.' })
    return
  }

  const token = authorization.replace('Bearer ', '')

  try {
    request.authUser = verifyToken(token)
    // Root no necesita verificación de empresa
    if (request.authUser.role === 'root') {
      next()
      return
    }
    // Verifica que la empresa esté activa
    void checkCompanyActive(request, response, next)
  } catch {
    response.status(401).json({ message: 'Token invalido o vencido.' })
  }
}

/** Caché corta del estado "activa" por empresa: evita una consulta a Mongo en cada request. */
const ACTIVE_CACHE_TTL_MS = 20_000
const activeCache = new Map<string, { activa: boolean; at: number }>()

/** Devuelve false solo si la empresa existe y está marcada como inactiva. Falla abierto. */
async function isCompanyActive(companyId: string): Promise<boolean> {
  const hit = activeCache.get(companyId)
  if (hit && Date.now() - hit.at < ACTIVE_CACHE_TTL_MS) return hit.activa
  const company = (await (await getCompaniesCollection()).findOne(
    { id: companyId } as any,
    { projection: { _id: 0, activa: 1 } },
  )) as { activa?: boolean } | null
  const activa = company?.activa !== false
  activeCache.set(companyId, { activa, at: Date.now() })
  return activa
}

async function checkCompanyActive(request: Request, response: Response, next: NextFunction) {
  try {
    if (!(await isCompanyActive(request.authUser!.companyId))) {
      response.status(403).json({ message: 'Tu empresa está inactiva. Contacta al administrador del sistema.' })
      return
    }
  } catch {
    // Si falla la lectura, dejar pasar
  }
  next()
}

/**
 * Middleware que verifica que la empresa del usuario esté activa.
 * Se aplica después de requireAuth. Root está exento.
 */
export async function requireActiveCompany(request: Request, response: Response, next: NextFunction) {
  if (!request.authUser || request.authUser.role === 'root') {
    next()
    return
  }

  try {
    if (!(await isCompanyActive(request.authUser.companyId))) {
      response.status(403).json({ message: 'Tu empresa está inactiva. Contacta al administrador del sistema.' })
      return
    }
  } catch {
    // Si falla la lectura, dejar pasar (no bloquear por error de DB)
  }

  next()
}

/**
 * Middleware que verifica que el usuario autenticado sea root.
 */
export function requireRoot(request: Request, response: Response, next: NextFunction) {
  if (!request.authUser || request.authUser.role !== 'root') {
    response.status(403).json({ message: 'Acceso denegado. Se requiere rol root.' })
    return
  }
  next()
}

/**
 * Middleware de roles.
 * Si los roles permitidos incluyen 'supervisor', también verifica si el
 * cargo del usuario en la DB contiene "supervisor" (caso: role=operativo pero cargo=Supervisor de X).
 */
export function requireRole(roles: UserRole[]) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.authUser) {
      response.status(401).json({ message: 'Sesion no valida.' })
      return
    }

    // Si el role del JWT coincide directamente → OK
    if (roles.includes(request.authUser.role as UserRole)) {
      next()
      return
    }

    // Si los roles permitidos incluyen 'supervisor', verifica por cargo en DB
    if (roles.includes('supervisor') && request.authUser.role === 'operativo') {
      try {
        if (request._resolvedSupervisor === undefined) {
          const user = (await (await getUsersCollection()).findOne(
            { id: request.authUser!.userId } as any,
            { projection: { _id: 0, cargo: 1 } },
          )) as { cargo?: string } | null
          request._resolvedSupervisor = Boolean(user?.cargo?.toLowerCase().includes('supervisor'))
        }
        if (request._resolvedSupervisor) {
          next()
          return
        }
      } catch {
        // Si falla la lectura de DB, usa solo el rol del JWT
      }
    }

    response.status(403).json({ message: 'No tienes permisos para esta accion.' })
  }
}
