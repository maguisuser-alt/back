// ── Tipos de operación ──────────────────────────────────────────────────

export type OperationType = 'PRODUCTOS_ENTRANTES' | 'PRODUCTOS_SALIENTES' | 'ACTIVIDAD'
export type OperationStatus = 'EN_PROCESO' | 'COMPLETADO'

// ── Configuración por tipo ──────────────────────────────────────────────

export const MULTI_PHOTO_STEPS: Record<OperationType, number[]> = {
  PRODUCTOS_ENTRANTES: [0],
  PRODUCTOS_SALIENTES: [0],
  ACTIVIDAD: [0],
}

export const PRODUCT_CODE_STEPS: Record<OperationType, number[]> = {
  PRODUCTOS_ENTRANTES: [],
  PRODUCTOS_SALIENTES: [],
  ACTIVIDAD: [],
}

export const OPTIONAL_PRODUCT_CODE_STEPS: Record<OperationType, number[]> = {
  PRODUCTOS_ENTRANTES: [],
  PRODUCTOS_SALIENTES: [],
  ACTIVIDAD: [],
}

export const OPTIONAL_STEPS: Record<OperationType, number[]> = {
  PRODUCTOS_ENTRANTES: [0],
  PRODUCTOS_SALIENTES: [0],
  ACTIVIDAD: [0],
}

export const FREE_STEPS: Record<OperationType, number[]> = {
  PRODUCTOS_ENTRANTES: [0],
  PRODUCTOS_SALIENTES: [0],
  ACTIVIDAD: [0],
}

/** Pasos para revisión de Línea Blanca — ya no se usa como secuencia fija */
export const LINEA_BLANCA_STEPS = [
  'Registro fotográfico',
] as const

export function getStepsForType(_type: OperationType): readonly string[] {
  return ['Registro fotográfico']
}

// ── Esquema de foto ─────────────────────────────────────────────────────

export type PhotoType = 'proceso' | 'producto'

export interface PhotoRecord {
  stepIndex: number
  stepName: string
  driveUrl: string
  fileId: string
  productCode?: string
  photoIndex?: number
  comment?: string
  photoType?: PhotoType
  /** Tipo de medio del item: imagen (default), audio o documento. */
  mediaType?: 'image' | 'audio' | 'document'
  /** Nombre del archivo (para audios/documentos). */
  fileName?: string
  /** MIME del archivo (para audios/documentos). */
  mimeType?: string
  timestamp: string
  /** Agrupa fotos tomadas juntas (una misma tanda) para mostrarlas como un álbum. */
  groupId?: string
  /**
   * Clave de idempotencia generada por el cliente (`${trackingCode}:${clientTimestamp}:${rand}`).
   * Permite deduplicar subidas (reintentos/envíos concurrentes) y que el cliente
   * reconcilie su marcador local con la foto confirmada por el servidor.
   */
  clientKey?: string
}

// ── Datos de etiqueta ───────────────────────────────────────────────────

export interface LabelData {
  poNumber?: string
  sku?: string
  sscc?: string
  destinatario?: string
  np?: string
  codigoEtiqueta?: string
  transportadora?: string
  complemento?: string
  descripcion?: string
}

// ── Producto (antes "Línea Blanca") ─────────────────────────────────────

export interface LineaBlancaProduct {
  productCode: string
  labelData?: LabelData
  isLineaBlanca?: boolean
  linkedTo?: string[]              // trackingCodes de operaciones vinculadas
  photos: PhotoRecord[]
  status: 'EN_PROCESO' | 'COMPLETADO'
  createdAt: string
}

// ── Ubicaciones y movimientos ───────────────────────────────────────────

/** Lugar/ubicación donde se realiza la operación (configurado por empresa). */
export interface CompanyLocation {
  id: string
  name: string
  address?: string
  city?: string
}

/** Tipo de ubicación: un Lugar configurado o un Vehículo (por placa). */
export type LocationType = 'lugar' | 'vehiculo'

/**
 * Referencia a una ubicación. Se usa como origen/destino en las operaciones y en
 * los movimientos. `name` se desnormaliza para conservar el texto a mostrar aunque
 * el lugar se elimine de la configuración.
 */
export interface LocationRef {
  type: LocationType
  /** Presente si type === 'lugar' (id del lugar configurado). */
  id?: string
  /** Presente si type === 'vehiculo' (placa normalizada en MAYÚSCULAS). */
  placa?: string
  /** Nombre a mostrar (nombre del lugar o la placa). */
  name: string
}

/**
 * Movimiento de un producto entre ubicaciones (colección `product_movements`).
 * Una fila por cada cambio de ubicación. Su secuencia forma el recorrido.
 */
export interface ProductMovement {
  companyId: string
  productCode: string
  productCodeLower: string
  /** Origen (null si no había ubicación previa ni origen explícito). */
  from: LocationRef | null
  /** Destino: ubicación donde queda alojado el producto. */
  to: LocationRef
  /** Operación que generó el movimiento. */
  trackingCode: string
  /** true si el origen se dedujo de la ubicación actual (traspaso inferido). */
  inferred: boolean
  /** ISO timestamp del movimiento. */
  at: string
}

// ── Esquema de operación ────────────────────────────────────────────────

export interface OperationLog {
  trackingCode: string
  operationType: OperationType
  operatorName: string
  vehiclePlate?: string            // Opcional — el usuario decide si incluirla
  /** Lugar donde se realiza la operación (id del lugar configurado). Legacy: se
   *  sigue llenando desde `destination` cuando es de tipo lugar. */
  locationId?: string
  /** Nombre del lugar (desnormalizado para historial aunque se borre el lugar). */
  locationName?: string
  /** true si la operación es un traspaso de productos entre ubicaciones. */
  isTransfer?: boolean
  /** Punto de inicio (opcional) del traspaso. */
  origin?: LocationRef
  /** Punto final: ubicación donde quedan alojados los productos de la operación. */
  destination?: LocationRef
  companyId?: string
  photos: PhotoRecord[]
  lineaBlanca: LineaBlancaProduct[]
  status: OperationStatus
  createdAt: string
  updatedAt: string
  /** Hora en que se marcó como completado el registro. */
  completedAt?: string
}

/**
 * Normaliza un timestamp enviado por el cliente (hora real de captura en el
 * dispositivo). Si es una fecha ISO válida y razonable (no muy en el futuro),
 * la usa; de lo contrario cae a la hora del servidor. Esto evita el desfase
 * que se producía al usar la hora del servidor en el momento de la subida en
 * segundo plano.
 */
export function normalizeClientTimestamp(clientTimestamp: unknown): string {
  if (typeof clientTimestamp === 'string') {
    const t = Date.parse(clientTimestamp)
    // Válida y no más de 1 día en el futuro (tolerancia a relojes desfasados).
    if (!Number.isNaN(t) && t <= Date.now() + 24 * 60 * 60 * 1000) {
      return new Date(t).toISOString()
    }
  }
  return new Date().toISOString()
}
