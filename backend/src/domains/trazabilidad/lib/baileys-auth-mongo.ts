/**
 * Adaptador de autenticación de Baileys para el dominio TRAZABILIDAD.
 *
 * Shim del módulo único `src/whatsapp/auth-mongo.ts`: conserva la firma
 * original `useMongoAuthState(sessionId)` / `listSavedSessionKeys()` y su
 * colección (`whatsapp_web_auth`), de modo que la base de datos queda intacta.
 */
import {
  useMongoAuthState as coreUseMongoAuthState,
  listSavedSessionKeys as coreListSavedSessionKeys,
} from '../../../whatsapp/auth-mongo.js'

const COLLECTION = 'whatsapp_web_auth'

export function useMongoAuthState(sessionId = 'default') {
  return coreUseMongoAuthState('trazabilidad', COLLECTION, sessionId)
}

export function listSavedSessionKeys(): Promise<string[]> {
  return coreListSavedSessionKeys('trazabilidad', COLLECTION)
}
