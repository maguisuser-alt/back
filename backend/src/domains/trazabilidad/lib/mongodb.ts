/**
 * Acceso a MongoDB del dominio TRAZABILIDAD.
 *
 * Shim que delega TODO en la capa única ../../core/mongo.ts (un solo
 * MongoClient para todo el backend). Los nombres de base y de colección son
 * idénticos a los que usaba trasabilidad-product/backend: la base queda intacta.
 *
 * getDb() se mantiene SÍNCRONO (igual que el original), por eso connectToMongo()
 * deja el handle cacheado en cuanto el pool compartido está listo.
 */
import type { Collection, Db } from 'mongodb'
import { getDb as coreDb } from '../../../core/mongo.js'

const DOMAIN = 'trazabilidad' as const

let cached: Db | null = null

/** Inicializa (lazy, idempotente) y deja disponible getDb() de forma síncrona. */
export async function connectToMongo(): Promise<Db> {
  if (cached) return cached
  cached = await coreDb(DOMAIN)
  return cached
}

export function getDb(): Db {
  if (!cached) {
    throw new Error('MongoDB no inicializado. Llama a connectToMongo() primero.')
  }
  return cached
}

export function getOperationsCollection(): Collection {
  return getDb().collection('operations')
}

export function getProductsCatalogCollection(): Collection {
  return getDb().collection('products_catalog')
}

export function getMovementsCollection(): Collection {
  return getDb().collection('product_movements')
}
