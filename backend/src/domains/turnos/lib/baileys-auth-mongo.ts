/**
 * Adaptador de autenticación de Baileys para el dominio TURNOS.
 *
 * Shim del módulo único `src/whatsapp/auth-mongo.ts`: conserva la firma
 * original `useMongoAuthState(sessionId)` y su colección (`whatsapp_turnos_auth`),
 * de modo que la base de datos queda intacta.
 */
import { useMongoAuthState as coreUseMongoAuthState } from '../../../whatsapp/auth-mongo.js'

const COLLECTION = 'whatsapp_turnos_auth'

export function useMongoAuthState(sessionId = 'default') {
  return coreUseMongoAuthState('turnos', COLLECTION, sessionId)
}
