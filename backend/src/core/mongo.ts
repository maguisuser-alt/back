/**
 * Capa ÚNICA de acceso a MongoDB para todos los dominios del backend.
 *
 * Un solo MongoClient (un solo pool de conexiones) que expone un handle `Db`
 * por dominio. Los nombres de base de datos y de colección NO cambian: es una
 * unificación de CÓDIGO, no de esquema. La base de datos queda intacta.
 *
 *   turnos        → MONGODB_DB_TURNOS        (default: ommex_register)
 *   trazabilidad  → MONGODB_DB_TRAZABILIDAD  (default: pluscargo_logging)
 *   academia      → MONGODB_DB_ACADEMIA      (default: ommex_academia)
 */
import { MongoClient, type Collection, type Db, type Document } from 'mongodb'

export type Domain = 'turnos' | 'trazabilidad' | 'academia'

/** Nombre de base por dominio — idéntico al que cada producto usaba antes. */
const DB_NAMES: Record<Domain, string> = {
  turnos: process.env.MONGODB_DB_TURNOS ?? process.env.MONGODB_DB_NAME ?? 'ommex_register',
  trazabilidad: process.env.MONGODB_DB_TRAZABILIDAD ?? 'pluscargo_logging',
  academia: process.env.MONGODB_DB_ACADEMIA ?? 'ommex_academia',
}

let client: MongoClient | null = null
let connecting: Promise<MongoClient> | null = null

function resolveUri(): string {
  const uri = process.env.MONGODB_URI
  if (!uri || !uri.trim()) {
    // Sin fallback hardcodeado: nunca se embeben credenciales en el repositorio.
    throw new Error('[mongo] MONGODB_URI no está definida. Configúrala en el entorno.')
  }
  return uri.trim()
}

/** Cliente único (lazy + dedupe de conexiones concurrentes). */
export async function getClient(): Promise<MongoClient> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    const c = new MongoClient(resolveUri(), {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
    })
    await c.connect()
    client = c
    console.log('[mongo] cliente conectado (pool único para todos los dominios)')
    return c
  })()

  try {
    return await connecting
  } catch (err) {
    client = null
    throw err
  } finally {
    connecting = null
  }
}

/** Handle de base por dominio. */
export async function getDb(domain: Domain): Promise<Db> {
  const c = await getClient()
  return c.db(DB_NAMES[domain])
}

/** Colección tipada por dominio + nombre (mismos nombres de colección de antes). */
export async function getCollection<T extends Document = Document>(
  domain: Domain,
  name: string,
): Promise<Collection<T>> {
  return (await getDb(domain)).collection<T>(name)
}

/** Nombre de base efectivo de un dominio (para health/diagnóstico). */
export function dbNameOf(domain: Domain): string {
  return DB_NAMES[domain]
}

/** Ping de readiness de un dominio. */
export async function ping(domain: Domain): Promise<void> {
  const db = await getDb(domain)
  await db.command({ ping: 1 })
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    console.log('[mongo] conexión cerrada')
  }
}
