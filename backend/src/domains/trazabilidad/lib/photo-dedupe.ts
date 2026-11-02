/**
 * Utilidades puras de deduplicación de fotos por `clientKey`.
 *
 * Se extraen de los handlers de subida para poder probarlas sin Mongo ni
 * almacenamiento. Garantizan las propiedades de corrección del diseño:
 *  - Property 1 (idempotencia): a lo sumo 1 foto por `clientKey`.
 *  - Property 2 (no pérdida ni duplicación en batch): N entradas nuevas → N,
 *    descontando solo las que ya existían por `clientKey`.
 */

export interface HasClientKey {
  clientKey?: string
}

/** Conjunto de claves de idempotencia ya presentes (ignora las vacías). */
export function existingClientKeys(photos: ReadonlyArray<HasClientKey>): Set<string> {
  return new Set(photos.map((p) => p.clientKey).filter((k): k is string => Boolean(k)))
}

/** True si `clientKey` (no vacío) ya está presente en el conjunto. */
export function isDuplicateKey(existing: Set<string>, clientKey?: string): boolean {
  return Boolean(clientKey) && existing.has(clientKey as string)
}

export interface PartitionResult<T> {
  /** Entradas que deben subirse/insertarse (nuevas). */
  toInsert: T[]
  /** Cuántas entradas se omitieron por ser duplicadas (clientKey ya presente). */
  skipped: number
}

/**
 * Reparte una tanda de entradas en "a insertar" vs "omitidas", deduplicando por
 * `clientKey` tanto contra las ya existentes como contra duplicados dentro de la
 * misma tanda. Las entradas sin `clientKey` nunca se consideran duplicadas.
 */
export function partitionNewPhotos<T extends HasClientKey>(
  existingPhotos: ReadonlyArray<HasClientKey>,
  incoming: ReadonlyArray<T>,
): PartitionResult<T> {
  const seen = existingClientKeys(existingPhotos)
  const toInsert: T[] = []
  let skipped = 0
  for (const item of incoming) {
    const key = item.clientKey
    if (key && seen.has(key)) { skipped++; continue }
    if (key) seen.add(key)
    toInsert.push(item)
  }
  return { toInsert, skipped }
}
