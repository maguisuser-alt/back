/**
 * Definición y lectura de las funciones (feature flags) de trazabilidad.
 * Compartido entre `routes/settings.ts` y `routes/mfe.ts` para que el valor
 * efectivo y el mapa `allowedFeatures` sean idénticos en ambos contratos.
 */

/** Claves de funciones de trazabilidad que el root puede permitir/denegar. */
export const FEATURE_KEYS = [
  'sheetsEnabled', 'activityLog', 'sendEmail', 'whatsappTrazabilidad', 'whatsappUnified',
  'whatsappAudio', 'whatsappCatalog', 'whatsappDocument', 'markerEditor', 'registrarActividad',
  // Acciones del menú "+" del registro, activables/desactivables por empresa.
  'addProduct', 'selectImage', 'pasteImage',
  // Lugares/ubicaciones: identificar dónde se hace la operación y ubicar productos.
  'locationsEnabled',
  // Marca de agua en fotos.
  'watermark', 'watermarkDate', 'watermarkTime', 'watermarkLocation',
] as const
export type FeatureKey = typeof FEATURE_KEYS[number]

/** Límite por defecto de tipos de operación personalizados (0 = sin límite). */
export const DEFAULT_OPERATION_TYPES_LIMIT = 0

/** Presencia de la integración de turnos a nivel de despliegue. */
export const TURNOS_API_URL = (process.env.TURNOS_API_URL || '').replace(/\/$/, '')

/**
 * Devuelve el mapa de funciones PERMITIDAS por el root. El panel root es la
 * autoridad: una función solo está permitida si el root la activó. Por defecto
 * (sin configurar o clave ausente) NO se permite.
 */
/** Acciones base del registro: permitidas por defecto (default-on). Solo se
 *  consideran denegadas si el ROOT las apaga explícitamente (=== false). */
export const DEFAULT_ON_KEYS: readonly FeatureKey[] = [
  'addProduct', 'selectImage', 'pasteImage', 'locationsEnabled',
  'watermark', 'watermarkDate', 'watermarkTime', 'watermarkLocation',
]

export function readAllowed(doc: Record<string, unknown> | null): Record<FeatureKey, boolean> {
  const stored = (doc?.allowedFeatures ?? null) as Record<string, unknown> | null
  const out = {} as Record<FeatureKey, boolean>
  for (const k of FEATURE_KEYS) {
    if (DEFAULT_ON_KEYS.includes(k)) {
      // default-on: true salvo que esté explícitamente en false.
      out[k] = stored ? stored[k] !== false : true
    } else {
      // default-off: true solo si el ROOT lo activó explícitamente.
      out[k] = stored ? stored[k] === true : false
    }
  }
  return out
}

/** Límite efectivo de tipos de operación de un documento de company_settings. */
export function readOperationTypesLimit(doc: Record<string, unknown> | null): number {
  return typeof doc?.operationTypesLimit === 'number' ? doc.operationTypesLimit : DEFAULT_OPERATION_TYPES_LIMIT
}

/** Estado EFECTIVO del vínculo con turnos: permitido por el root Y con URL. */
export function turnosLinked(allowed: Record<FeatureKey, boolean>): boolean {
  return allowed.whatsappUnified === true && Boolean(TURNOS_API_URL)
}
