/**
 * Backend unificado Ommex.
 *
 * Un solo proceso Express que contiene los dominios TURNOS, TRAZABILIDAD y
 * ACADEMIA. Cada dominio conserva SUS rutas internas (/api/...), por eso se
 * montan bajo un prefijo de dominio:
 *
 *   /turnos/api/...        (antes: back-turnos-ommex.fly.dev/api/...)
 *   /trazabilidad/api/...  (antes: trasabilidad backend /api/...)
 *   /academia/api/...      (antes: academia-ommex.fly.dev/api/...)
 *   /health, /health/db    (contracto único de salud para el gateway/monitores)
 *
 * La base de datos NO cambia: cada dominio sigue leyendo la misma base y las
 * mismas colecciones, solo que a través de un único MongoClient (core/mongo.ts).
 */
import cors from 'cors'
import express from 'express'
import { createErrorHandler, notFoundHandler } from './core/http.js'
import { dbNameOf, ping } from './core/mongo.js'
import { turnosRouter } from './domains/turnos/index.js'
import { trazabilidadRouter } from './domains/trazabilidad/index.js'
import { academiaRouter } from './domains/academia/index.js'

export const app = express()

// ETag desactivado: evita 304 con cuerpo vacío en el polling de operaciones.
app.set('etag', false)

// Dev local: CUALQUIER puerto en `localhost` o `127.0.0.1`. Vite imprime la URL
// como http://127.0.0.1:517x, que antes no estaba en la lista blanca: el
// navegador bloqueaba TODAS las peticiones al backend y el front lo mostraba
// como error de red genérico ("El servidor está iniciando..."), aunque el
// servidor estuviera arriba. Un `origin` no permitido deja la respuesta sin
// `Access-Control-Allow-Origin` y el navegador descarta la respuesta.
const LOCAL_DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

app.use(cors({
  origin: [
    LOCAL_DEV_ORIGIN,
    'https://asignacion-register.vercel.app',
    /\.vercel\.app$/,
    /\.onrender\.com$/,
    /\.fly\.dev$/,
  ],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Límite alto: trazabilidad sube fotos grandes (antes 60mb; turnos usaba 10mb).
app.use(express.json({ limit: '60mb' }))

// ── Salud unificada (liveness + readiness por dominio) ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ommex-backend', timestamp: new Date().toISOString() })
})

app.get('/health/db', async (_req, res) => {
  const databases: Record<string, string> = {}
  let allOk = true
  for (const domain of ['turnos', 'trazabilidad', 'academia'] as const) {
    try {
      await ping(domain)
      databases[domain] = `${dbNameOf(domain)}:connected`
    } catch {
      databases[domain] = `${dbNameOf(domain)}:disconnected`
      allOk = false
    }
  }
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', databases })
})

// ── Dominios (namespaceados para evitar el choque de /api) ──
app.use('/turnos', turnosRouter)
app.use('/trazabilidad', trazabilidadRouter)
app.use('/academia', academiaRouter)

app.use(notFoundHandler)
app.use(createErrorHandler())
