/**
 * photo-refs.ts — saber qué archivos de fotos siguen en uso antes de borrarlos.
 *
 * Al VINCULAR un producto a otro registro, el registro nuevo copia las
 * referencias de fotos del original (`photos: [...sourceProduct.photos]`): ambos
 * apuntan a los MISMOS archivos en R2/GitHub, guardados bajo el prefijo del
 * registro original (`operations/<registroOriginal>/...`).
 *
 * Por eso, borrar un registro (a mano o por la limpieza automática) borrando sus
 * archivos sin más dejaba sin imágenes a los registros vinculados que seguían
 * vivos. Este módulo calcula qué archivos siguen referenciados por OTROS
 * registros, para conservarlos.
 */
import { getOperationsCollection } from './mongodb.js'

export type PhotoRef = { fileId?: string; driveUrl?: string }

/** Identificadores del archivo de una foto: la key de R2 (fileId) y la URL sin query. */
export function photoIds(ph: PhotoRef): string[] {
  const ids: string[] = []
  const fid = ph.fileId
  if (fid && fid !== 'pending' && fid !== 'note' && fid !== 'inline') ids.push(fid)
  const url = ph.driveUrl
  // Las URLs firmadas de R2 cambian de query al re-firmarse: se compara sin ella.
  if (url && /^https?:\/\//.test(url)) ids.push(url.split('?')[0])
  return ids
}

/**
 * Identificadores de fotos referenciados por los registros que NO se van a
 * borrar. Opcionalmente excluye un producto concreto (cuando se borra solo un
 * producto de un registro que sigue existiendo).
 *
 * Si `companyId` viene, se limita a esa empresa (los vínculos son dentro de la
 * misma empresa); si no, revisa todos los registros (más conservador).
 */
export async function referencedPhotoIdsExcept(opts: {
  companyId?: string
  excludeOps?: string[]
  excludeProduct?: { trackingCode: string; productCode: string }
}): Promise<Set<string>> {
  const filter: Record<string, unknown> = {}
  if (opts.companyId) filter.companyId = opts.companyId
  if (opts.excludeOps?.length) filter.trackingCode = { $nin: opts.excludeOps }

  const refs = new Set<string>()
  const cursor = getOperationsCollection().find(filter, {
    projection: {
      _id: 0,
      trackingCode: 1,
      'photos.fileId': 1,
      'photos.driveUrl': 1,
      'lineaBlanca.productCode': 1,
      'lineaBlanca.photos.fileId': 1,
      'lineaBlanca.photos.driveUrl': 1,
    },
  })
  for await (const op of cursor) {
    for (const ph of (op.photos as PhotoRef[] | undefined) ?? []) {
      for (const id of photoIds(ph)) refs.add(id)
    }
    const products = (op.lineaBlanca as Array<{ productCode?: string; photos?: PhotoRef[] }> | undefined) ?? []
    for (const prod of products) {
      const ex = opts.excludeProduct
      if (ex && op.trackingCode === ex.trackingCode && prod.productCode === ex.productCode) continue
      for (const ph of prod.photos ?? []) {
        for (const id of photoIds(ph)) refs.add(id)
      }
    }
  }
  return refs
}

/** True si el archivo de esta foto lo sigue usando otro registro. */
export function isPhotoShared(ph: PhotoRef, refs: Set<string>): boolean {
  return photoIds(ph).some((id) => refs.has(id))
}

/**
 * True si algún archivo bajo `prefix` (p. ej. `operations/ABC/`) sigue en uso.
 * En ese caso NO se debe borrar por prefijo, solo los archivos no compartidos.
 */
export function isPrefixReferenced(prefix: string, refs: Set<string>): boolean {
  for (const id of refs) {
    if (id.startsWith(prefix) || id.includes(`/${prefix}`)) return true
  }
  return false
}
