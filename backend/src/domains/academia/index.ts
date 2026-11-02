/**
 * Dominio ACADEMIA: agrega sus routers (mismos paths /api/*) sobre el pool
 * único de MongoDB y expone su health.
 *
 * Se monta en el backend unificado bajo el prefijo /academia, por lo que las
 * rutas quedan como /academia/api/... (antes: academia-ommex.fly.dev/api/...).
 */
import { Router } from 'express'
import { dbNameOf } from '../../core/mongo.js'
import { academicRouter } from './routes/academic.js'
import { mfeRouter } from './routes/mfe.js'
import { academicAttendanceRouter } from './routes/academic-attendance.js'
import { authRouter } from './routes/auth.js'
import { companiesRouter } from './routes/companies.js'
import { locationsRouter } from './routes/locations.js'
import { rootRouter } from './routes/root.js'
import { settingsRouter } from './routes/settings.js'
import { connectMongo } from './lib/mongodb.js'

export const academiaRouter = Router()

academiaRouter.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ommex-academia', timestamp: new Date().toISOString() })
})

academiaRouter.get('/api/health/db', async (_req, res) => {
  try {
    const db = await connectMongo()
    await db.command({ ping: 1 })
    res.json({ status: 'connected', db: dbNameOf('academia') })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(503).json({ status: 'disconnected', error: message })
  }
})

academiaRouter.use('/api/auth', authRouter)
academiaRouter.use('/api/root', rootRouter)
academiaRouter.use('/api/companies', companiesRouter)
academiaRouter.use('/api/settings', settingsRouter)
academiaRouter.use('/api/locations', locationsRouter)
academiaRouter.use('/api/mfe', mfeRouter)
academiaRouter.use('/api/academic', academicRouter)
academiaRouter.use('/api/academic-attendance', academicAttendanceRouter)

/** Reintenta la conexión a MongoDB en segundo plano sin bloquear el servidor. */
function retryMongo() {
  const RETRY_INTERVAL = 30_000
  const attempt = async () => {
    try {
      await connectMongo()
      console.log('[academia] MongoDB conectado (reintento exitoso).')
    } catch {
      setTimeout(attempt, RETRY_INTERVAL)
    }
  }
  setTimeout(attempt, RETRY_INTERVAL)
}

/** Inicializa el dominio: conexión al pool único (lazy, con reintento). */
export async function initAcademia(): Promise<void> {
  try {
    await connectMongo()
    console.log('[academia] MongoDB conectado.')
  } catch (err) {
    console.warn('[academia] MongoDB no disponible al iniciar; se reintentará en segundo plano.', err instanceof Error ? err.message : err)
    retryMongo()
  }
}
