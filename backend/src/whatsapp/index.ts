/**
 * Módulo ÚNICO de WhatsApp Web (Baileys) compartido por todos los dominios.
 *
 * - `auth-mongo.ts`      → persistencia de la sesión en MongoDB.
 * - `session-manager.ts` → ciclo de vida de la conexión y envío de mensajes.
 *
 * Cada dominio (`turnos`, `trazabilidad`) envuelve este módulo con un shim que
 * conserva sus firmas originales, de modo que ninguna ruta tuvo que cambiar.
 */
export * from './auth-mongo.js'
export * from './session-manager.js'
