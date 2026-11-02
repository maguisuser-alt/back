/**
 * Utilidades HTTP compartidas: envoltura async, error handler único y 404.
 * Reemplazan los bloques de error-handler que antes estaban duplicados en el
 * app.ts/server.ts de cada backend.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AppError, isMongoUnavailable } from './errors.js'

/** Envuelve handlers async para que sus rechazos lleguen al errorHandler. */
export function asyncHandler(
  fn: (req: any, res: any, next: any) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** Error handler único del backend. */
export function createErrorHandler(
  log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err),
): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (res.headersSent) return
    if (err instanceof AppError) {
      res.status(err.status).json({ message: err.message, code: err.code })
      return
    }
    if (isMongoUnavailable(err)) {
      res.status(503).json({ message: 'Base de datos no disponible. Verifica la conexión a MongoDB Atlas.', code: 'DB_UNAVAILABLE' })
      return
    }
    log('[error-handler]', err)
    res.status(500).json({ message: 'Error interno del servidor.', code: 'INTERNAL_ERROR' })
  }
}

/** Handler 404 con respuesta JSON homogénea. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada', code: 'NOT_FOUND' })
}
