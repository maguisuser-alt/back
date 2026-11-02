/**
 * Dominio TRAZABILIDAD: agrega sus routers (mismos paths /api/*) e inicializa
 * su conexión al pool único de MongoDB, el barrido de sesiones, la limpieza
 * automática y el mantenimiento de WhatsApp Web.
 *
 * Se monta en el backend unificado bajo el prefijo /trazabilidad, por lo que
 * las rutas quedan como /trazabilidad/api/...
 */
import { Router } from 'express'
import { requireToken } from './middleware/requireToken.js'
import { connectToMongo } from './lib/mongodb.js'
import { authRouter } from './routes/auth.js'
import { operationsRouter } from './routes/operations.js'
import { photosRouter } from './routes/photos.js'
import { settingsRouter } from './routes/settings.js'
import { mfeRouter } from './routes/mfe.js'
import { sheetsRouter } from './routes/sheets.js'
import { uploadsRouter } from './routes/uploads.js'
import { whatsappRouter } from './routes/whatsapp.js'
import { whatsappWebRouter } from './routes/whatsapp-web.js'
import { adminRouter } from './routes/admin.js'
import { sweepExpiredSessions } from './lib/auth.js'
import { isWhatsAppWebEnabled, resumeSavedSessions, reconnectDroppedSessions } from './lib/whatsapp-web.js'
import { runCleanupOldOperations } from './jobs/cleanupOldOperations.js'

export const trazabilidadRouter = Router()

trazabilidadRouter.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ommex-tracer', timestamp: new Date().toISOString() })
})

// ── Rutas PÚBLICAS (sin token) ──
trazabilidadRouter.use('/api/auth', authRouter)

// ── Rutas PROTEGIDAS (requieren token de sesión válido) ──
trazabilidadRouter.use('/api/operations', requireToken, operationsRouter)
trazabilidadRouter.use('/api/photos', requireToken, photosRouter)
trazabilidadRouter.use('/api/settings', requireToken, settingsRouter)
trazabilidadRouter.use('/api/mfe', requireToken, mfeRouter)
trazabilidadRouter.use('/api/sheets', requireToken, sheetsRouter)
trazabilidadRouter.use('/api/uploads', requireToken, uploadsRouter)
trazabilidadRouter.use('/api/whatsapp', requireToken, whatsappRouter)
// WhatsApp Web (Baileys, vía QR) — módulo opcional, solo si está habilitado.
if (process.env.ENABLE_WHATSAPP_WEB === 'true') {
  trazabilidadRouter.use('/api/whatsapp-web', requireToken, whatsappWebRouter)
  console.log('[trazabilidad] WhatsApp Web (Baileys) HABILITADO en /trazabilidad/api/whatsapp-web')
}

// Rutas administrativas (sin token, igual que antes)
trazabilidadRouter.use('/api/admin', adminRouter)

/** Evita programar el barrido/arranque más de una vez (reintentos de conexión). */
let cleanupScheduled = false
let whatsappMaintenanceStarted = false

/**
 * Mantiene WhatsApp Web activo: reanuda al arrancar las sesiones con
 * credenciales guardadas y reconecta periódicamente las que queden caídas.
 */
function startWhatsAppMaintenance() {
  if (whatsappMaintenanceStarted) return
  if (!isWhatsAppWebEnabled()) return
  whatsappMaintenanceStarted = true
  void resumeSavedSessions()
  setInterval(() => { void reconnectDroppedSessions() }, 60_000)
}

/**
 * Limpieza automática: el job SOLO elimina operaciones de empresas que la
 * activaron (cleanupEnabled = true). ENABLE_AUTO_CLEANUP=false la desactiva.
 */
function scheduleCleanup() {
  if (process.env.ENABLE_AUTO_CLEANUP === 'false') {
    console.log('[trazabilidad] Limpieza automática DESACTIVADA por ENABLE_AUTO_CLEANUP=false.')
    return
  }
  if (cleanupScheduled) return
  cleanupScheduled = true

  const CHECK_INTERVAL = 60 * 60 * 1000 // cada 1 hora
  const check = async () => {
    try {
      const { deleted, skipped } = await runCleanupOldOperations()
      if (deleted > 0) console.log(`[trazabilidad][cleanup] Barrido completado: ${deleted} operación(es) eliminada(s).`)
      else if (skipped) console.log(`[trazabilidad][cleanup] Barrido sin cambios: ${skipped}`)
    } catch (err) {
      console.warn('[trazabilidad][cleanup] Error en el barrido programado:', err instanceof Error ? err.message : err)
    }
    setTimeout(check, CHECK_INTERVAL)
  }
  setTimeout(() => { void check() }, 60 * 1000)
  console.log('[trazabilidad] Limpieza automática ACTIVADA.')
}

/** Reintenta la conexión a MongoDB en segundo plano sin bloquear el servidor. */
function retryMongo() {
  const RETRY_INTERVAL = 30_000
  const attempt = async () => {
    try {
      await connectToMongo()
      console.log('[trazabilidad] MongoDB conectado (reintento exitoso).')
      scheduleCleanup()
      startWhatsAppMaintenance()
    } catch {
      setTimeout(attempt, RETRY_INTERVAL)
    }
  }
  setTimeout(attempt, RETRY_INTERVAL)
}

/** Inicializa el dominio: barrido de sesiones, conexión, limpieza y WhatsApp. */
export async function initTrazabilidad(): Promise<void> {
  // Barrido periódico (cada 10 min): solo acota memoria de sesiones.
  setInterval(() => {
    const removed = sweepExpiredSessions()
    if (removed > 0) console.log(`[trazabilidad][auth] ${removed} sesión(es) cerrada(s) por inactividad.`)
  }, 10 * 60 * 1000)

  try {
    await connectToMongo()
    console.log('[trazabilidad] MongoDB conectado.')
    scheduleCleanup()
    startWhatsAppMaintenance()
  } catch (err) {
    console.warn('[trazabilidad] MongoDB no disponible al iniciar; se reintentará en segundo plano.', err instanceof Error ? err.message : err)
    retryMongo()
  }
}
