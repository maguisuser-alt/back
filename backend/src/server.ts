/**
 * Arranque del backend unificado.
 *
 * El servidor escucha SIEMPRE, aunque MongoDB no esté disponible, para que las
 * funciones que solo dependen de Google Sheets / Apps Script sigan operativas.
 * Los endpoints que requieran Mongo devuelven un error controlado hasta que la
 * conexión esté lista (cada dominio reintenta en segundo plano).
 */
import { app } from './app.js'
import { initTurnos } from './domains/turnos/index.js'
import { initTrazabilidad } from './domains/trazabilidad/index.js'
import { initAcademia } from './domains/academia/index.js'

const PORT = Number(process.env.PORT) || 4000

async function start(): Promise<void> {
  app.listen(PORT, () => {
    console.log(`[ommex-backend] Servidor corriendo en http://localhost:${PORT}`)
    console.log('[ommex-backend] Dominios: /turnos, /trazabilidad, /academia | Salud: /health, /health/db')
  })

  // Inicializa los dominios en paralelo (comparten el mismo pool de Mongo).
  await Promise.all([initTurnos(), initTrazabilidad(), initAcademia()])
}

start().catch((err) => {
  console.error('Error al iniciar servidor:', err)
  process.exit(1)
})
