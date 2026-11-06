/**
 * Dominio TURNOS: agrega sus routers (mismos paths /api/*) e inicializa su
 * conexión al pool único de MongoDB y su job de autocierre de turnos.
 *
 * Se monta en el backend unificado bajo el prefijo /turnos, por lo que las
 * rutas quedan como /turnos/api/... y /turnos/health.
 */
import { Router } from 'express'
import swaggerUi from 'swagger-ui-express'
import { dbNameOf } from '../../core/mongo.js'
import { openApiDocument } from './lib/openapi.js'
import { authRouter } from './routes/auth.js'
import { rootRouter } from './routes/root.js'
import { attendanceRouter } from './routes/attendance.js'
import { companiesRouter } from './routes/companies.js'
import { groupsRouter } from './routes/groups.js'
import { locationsRouter } from './routes/locations.js'
import { messagesRouter } from './routes/messages.js'
import { operationsRouter } from './routes/operations.js'
import { positionsRouter } from './routes/positions.js'
import { settingsRouter } from './routes/settings.js'
import { usersRouter } from './routes/users.js'
import { turnsRouter } from './routes/turns.js'
import { whatsappTurnosRouter } from './routes/whatsapp-turnos.js'
import { whatsappConfigRouter } from './routes/whatsapp-config.js'
import { isWhatsAppTurnosEnabled, resumeSavedSessions, reconnectDroppedSessions } from './lib/whatsapp-turnos.js'
import { connectMongo, ensureTurnosIndexes } from './lib/mongodb.js'
import { runAutoCloseShifts } from './jobs/autoCloseShifts.js'
import { runTurnReminders } from './jobs/sendTurnReminders.js'

export const turnosRouter = Router()

turnosRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ommex-turnos', timestamp: new Date().toISOString() })
})

turnosRouter.get('/health/db', async (_req, res) => {
  try {
    const db = await connectMongo()
    await db.command({ ping: 1 })
    res.json({ status: 'connected', db: dbNameOf('turnos') })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(503).json({
      status: 'disconnected',
      error: message,
      hint: message.includes('SSL') || message.includes('tlsv1')
        ? 'MongoDB Atlas rechaza la conexión. Agrega 0.0.0.0/0 en Network Access de Atlas.'
        : 'Verifica MONGODB_URI y la configuración de red.',
    })
  }
})

turnosRouter.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDocument))

turnosRouter.use('/api/auth', authRouter)
turnosRouter.use('/api/root', rootRouter)
turnosRouter.use('/api/attendance', attendanceRouter)
turnosRouter.use('/api/companies', companiesRouter)
turnosRouter.use('/api/groups', groupsRouter)
turnosRouter.use('/api/locations', locationsRouter)
turnosRouter.use('/api/messages', messagesRouter)
turnosRouter.use('/api/operations', operationsRouter)
turnosRouter.use('/api/positions', positionsRouter)
turnosRouter.use('/api/settings', settingsRouter)
turnosRouter.use('/api/users', usersRouter)
turnosRouter.use('/api/turns', turnsRouter)

// WhatsApp de Turnos: solo se monta si está habilitado por configuración.
if (isWhatsAppTurnosEnabled()) {
  turnosRouter.use('/api/whatsapp-turnos', whatsappTurnosRouter)
  turnosRouter.use('/api/whatsapp-config', whatsappConfigRouter)
  console.log('[turnos] WhatsApp Turnos habilitado (ENABLE_WHATSAPP_TURNOS=true).')
}

const AUTO_CLOSE_INTERVAL_MS = 10 * 60 * 1000
const REMINDER_INTERVAL_MS = 5 * 60 * 1000

/** Evita programar el mantenimiento de WhatsApp más de una vez. */
let whatsappMaintenanceStarted = false

/**
 * Mantiene WhatsApp de Turnos activo: reanuda al arrancar las sesiones con
 * credenciales guardadas y reconecta periódicamente las que queden caídas
 * (misma lógica unificada que usa trazabilidad).
 */
function startWhatsAppMaintenance() {
  if (whatsappMaintenanceStarted) return
  if (!isWhatsAppTurnosEnabled()) return
  whatsappMaintenanceStarted = true
  void resumeSavedSessions()
  setInterval(() => { void reconnectDroppedSessions() }, 60_000)
}

/** Inicializa el dominio: conexión (lazy) y job de autocierre de turnos. */
export async function initTurnos(): Promise<void> {
  try {
    await connectMongo()
    console.log('[turnos] MongoDB conectado.')
    void ensureTurnosIndexes().catch((e) => console.warn('[turnos] No se pudieron crear índices:', e instanceof Error ? e.message : e))
  } catch (err) {
    console.warn('[turnos] MongoDB no disponible al iniciar; se reintentará por request.', err instanceof Error ? err.message : err)
  }
  startWhatsAppMaintenance()
  void runAutoCloseShifts().catch(() => {})
  setInterval(() => { void runAutoCloseShifts().catch(() => {}) }, AUTO_CLOSE_INTERVAL_MS)
  // Recordatorios de turno por WhatsApp (no hace nada si el canal está apagado)
  setInterval(() => { void runTurnReminders().catch((e) => console.warn('[recordatorios]', e instanceof Error ? e.message : e)) }, REMINDER_INTERVAL_MS)
}
