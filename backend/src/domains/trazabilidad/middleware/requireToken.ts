/**
 * Middleware de autenticación por token (Bearer).
 *
 * Protege las rutas de datos. Lee el token de `Authorization: Bearer <token>`,
 * lo verifica y, si la sesión sigue viva, inyecta la identidad en `req.session`
 * y continúa. Si no, responde 401 con un código para que el cliente reaccione
 * (p. ej. volver a crear sesión o cerrar sesión por inactividad).
 */
import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type SessionIdentity } from '../lib/auth.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionIdentity & { sessionId: string }
    }
  }
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  // Fallback: token por query (útil para EventSource/descargas que no envían headers).
  const q = req.query?.token
  if (typeof q === 'string' && q) return q
  return undefined
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  const result = verifyToken(token)

  if (!result.ok) {
    const status = 401
    const codeByReason: Record<string, string> = {
      malformed: 'TOKEN_MISSING',
      bad_signature: 'TOKEN_INVALID',
      no_session: 'SESSION_NOT_FOUND',
      expired: 'SESSION_EXPIRED',
    }
    const code = codeByReason[result.reason ?? 'malformed'] ?? 'UNAUTHORIZED'
    const message = result.reason === 'expired'
      ? 'Sesión cerrada por inactividad. Vuelve a iniciar sesión.'
      : 'No autorizado. Token inválido o ausente.'
    res.status(status).json({ message, code })
    return
  }

  const s = result.session!
  req.session = { sessionId: s.sessionId, companyId: s.companyId, user: s.user, role: s.role }
  next()
}
