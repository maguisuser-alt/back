/**
 * Rutas de autenticación por token.
 *
 *  POST /api/auth/session   → valida la identidad (companyId, user, role) y
 *                             emite un token. Mientras la sesión esté activa
 *                             (actividad en la última hora) el token es válido.
 *  POST /api/auth/heartbeat → "late" que mantiene viva la sesión y el backend
 *                             mientras el usuario tenga la app abierta. Renueva
 *                             la marca de actividad. Requiere token.
 *  POST /api/auth/logout    → cierra la sesión (invalida el token). Requiere token.
 *
 * Estas rutas son PÚBLICAS salvo heartbeat/logout, que exigen token.
 */
import { Router } from 'express'
import { createSession, destroySession, INACTIVITY_MS } from '../lib/auth.js'
import { requireToken } from '../middleware/requireToken.js'

export const authRouter = Router()

/**
 * POST /api/auth/session
 * Body: { companyId, user?, role? }
 * Devuelve: { token, expiresInMs, inactivityMs }
 *
 * La identidad proviene del portal que embebe la app. Se exige al menos
 * companyId para emitir el token.
 */
authRouter.post('/session', (req, res) => {
  const { companyId, user, role } = req.body ?? {}
  if (!companyId || !String(companyId).trim()) {
    res.status(400).json({ message: 'companyId es requerido para iniciar sesión.', code: 'COMPANY_REQUIRED' })
    return
  }
  const { token, expiresInMs } = createSession({
    companyId: String(companyId).trim(),
    user: String(user ?? '').trim(),
    role: String(role ?? '').trim(),
  })
  res.json({ token, expiresInMs, inactivityMs: INACTIVITY_MS })
})

/**
 * POST /api/auth/heartbeat
 * Mantiene viva la sesión (y el backend despierto) mientras el usuario está
 * activo. requireToken ya renueva la marca de actividad al verificar el token.
 */
authRouter.post('/heartbeat', requireToken, (req, res) => {
  res.json({ ok: true, inactivityMs: INACTIVITY_MS, user: req.session?.user ?? '' })
})

/**
 * POST /api/auth/logout
 * Cierra la sesión actual (invalida el token).
 */
authRouter.post('/logout', requireToken, (req, res) => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
  destroySession(token)
  res.json({ ok: true })
})
