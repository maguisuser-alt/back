/**
 * Lógica de ubicaciones y movimientos de productos (traspasos).
 *
 * Contiene funciones puras (normalización, igualdad, validación y la decisión de
 * si un movimiento debe registrarse) y helpers con acceso a datos
 * (ubicación actual y registro del movimiento). Las funciones puras se prueban
 * con `node:test` en `locations.test.ts`.
 */
import { getMovementsCollection } from './mongodb.js'
import type { CompanyLocation, LocationRef, ProductMovement } from '../types.js'

/** Normaliza una placa: MAYÚSCULAS y solo alfanumérico (sin espacios ni guiones). */
export function normalizePlaca(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim()
}

/**
 * Construye un `LocationRef` validado a partir de la entrada del cliente.
 * - Lugar: `{ type:'lugar', id }` debe existir en la lista de lugares de la empresa.
 * - Vehículo: `{ type:'vehiculo', placa }` con placa no vacía tras normalizar.
 * Devuelve null si la entrada es inválida o el lugar no existe.
 */
export function toLocationRef(input: unknown, places: CompanyLocation[]): LocationRef | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const type = obj.type

  if (type === 'lugar') {
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    if (!id) return null
    const place = places.find((p) => p.id === id)
    if (!place) return null
    return { type: 'lugar', id: place.id, name: place.name }
  }

  if (type === 'vehiculo') {
    const placa = normalizePlaca(obj.placa)
    if (!placa) return null
    return { type: 'vehiculo', placa, name: placa }
  }

  return null
}

/**
 * Igualdad de ubicaciones: mismo tipo y mismo identificador
 * (lugar por id, vehículo por placa normalizada). null nunca es igual a algo.
 */
export function sameLocation(a: LocationRef | null | undefined, b: LocationRef | null | undefined): boolean {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (a.type === 'lugar') return (a.id ?? '') === (b.id ?? '')
  return normalizePlaca(a.placa) === normalizePlaca(b.placa)
}

/** Nombre a mostrar de una ubicación (nombre del lugar o la placa). */
export function locationLabel(loc: LocationRef | null | undefined): string {
  if (!loc) return 'Sin ubicación'
  return (loc.name ?? '').trim() || (loc.type === 'vehiculo' ? (loc.placa ?? '') : '') || 'Ubicación'
}

/**
 * Resultado de decidir un movimiento: `shouldRecord` indica si hay cambio de
 * ubicación (y por tanto se debe insertar), con el `from` e `inferred` resueltos.
 */
export interface MovementDecision {
  shouldRecord: boolean
  from: LocationRef | null
  inferred: boolean
}

/**
 * FUNCIÓN PURA. Decide si un producto debe registrar un movimiento hacia `destination`:
 *  - from = originExplicit si se indicó; si no, la ubicación actual; si no, null.
 *  - inferred = true cuando el origen provino de la ubicación actual (no explícito).
 *  - no-op (shouldRecord=false) si el destino es igual a la ubicación actual.
 */
export function decideMovement(
  current: LocationRef | null,
  destination: LocationRef,
  originExplicit: LocationRef | null,
): MovementDecision {
  // Sin cambio de ubicación: el producto ya está en el destino.
  if (sameLocation(current, destination)) {
    return { shouldRecord: false, from: current, inferred: false }
  }
  if (originExplicit) {
    return { shouldRecord: true, from: originExplicit, inferred: false }
  }
  if (current) {
    // Traspaso inferido: usa la ubicación actual como origen.
    return { shouldRecord: true, from: current, inferred: true }
  }
  // Primer destino del producto, sin origen conocido.
  return { shouldRecord: true, from: null, inferred: false }
}

/** Ubicación actual de un producto: destino de su último movimiento, o null. */
export async function getCurrentLocation(companyId: string, productCode: string): Promise<LocationRef | null> {
  const col = getMovementsCollection()
  const doc = await col.findOne(
    { companyId, productCodeLower: productCode.trim().toLowerCase() },
    { sort: { at: -1 } },
  )
  return (doc?.to as LocationRef | undefined) ?? null
}

/**
 * Registra el movimiento de un producto hacia `destination` si corresponde.
 * Devuelve el movimiento creado o null si no hubo cambio (no-op) o faltó destino.
 * Falla de forma segura: ante un error de datos, loggea y devuelve null sin lanzar,
 * para no bloquear el registro fotográfico.
 */
export async function recordMovement(params: {
  companyId: string
  productCode: string
  destination: LocationRef | null | undefined
  originExplicit: LocationRef | null
  trackingCode: string
  at?: string
}): Promise<ProductMovement | null> {
  const { companyId, productCode, destination, originExplicit, trackingCode } = params
  if (!companyId || !productCode?.trim() || !destination) return null
  try {
    const current = await getCurrentLocation(companyId, productCode)
    const decision = decideMovement(current, destination, originExplicit)
    if (!decision.shouldRecord) return null
    const movement: ProductMovement = {
      companyId,
      productCode: productCode.trim(),
      productCodeLower: productCode.trim().toLowerCase(),
      from: decision.from,
      to: destination,
      trackingCode,
      inferred: decision.inferred,
      at: params.at ?? new Date().toISOString(),
    }
    await getMovementsCollection().insertOne(movement)
    return movement
  } catch (err) {
    console.error('[locations] Error al registrar movimiento:', err)
    return null
  }
}
