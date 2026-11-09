/**
 * Job de limpieza automática configurable:
 * - Solo corre para empresas con cleanupEnabled = true.
 * - Elimina los registros con más días que `cleanupDays` (default 20) y sus
 *   imágenes en R2 (por prefijo) y GitHub (una por una). Conserva los archivos
 *   que otro registro vigente sigue usando (productos vinculados).
 * - Reconoce `createdAt` guardado como texto ISO o como fecha (Date).
 * - Barre además los archivos HUÉRFANOS de R2 (de registros que ya no existen)
 *   con más días que el seleccionado.
 * - Guarda en company_settings.cleanupLastRun el resultado de cada ejecución,
 *   para poder comprobar desde la app que la limpieza corre.
 */
import { getOperationsCollection, getDb } from '../lib/mongodb.js'
import { deletePhotoStorage } from '../lib/drive-upload.js'
import { referencedPhotoIdsExcept, isPhotoShared } from '../lib/photo-refs.js'

const DEFAULT_MAX_AGE_DAYS = 20
const DAY_MS = 24 * 60 * 60 * 1000
/** Los huérfanos solo se barren una vez al día (listar el bucket es costoso). */
const ORPHAN_SWEEP_EVERY_MS = DAY_MS
/** Margen mínimo para un huérfano (evita tocar subidas en curso). */
const ORPHAN_MIN_AGE_DAYS = 2

type PhotoRef = { driveUrl?: string; fileId?: string }

export interface CleanupRunResult {
  at: string
  days: number
  operationsDeleted: number
  filesDeleted: number
  keptShared: number
  error?: string
}

function collectPhotos(op: Record<string, unknown>): PhotoRef[] {
  const refs: PhotoRef[] = []
  const push = (ph: PhotoRef) => {
    if (ph && (ph.driveUrl || ph.fileId)) refs.push(ph)
  }
  for (const ph of (op.photos as PhotoRef[]) ?? []) push(ph)
  for (const prod of (op.lineaBlanca as Array<{ photos?: PhotoRef[] }>) ?? []) {
    for (const ph of prod.photos ?? []) push(ph)
  }
  return refs
}

function daysOf(setting: Record<string, unknown> | null | undefined): number {
  const n = Number(setting?.cleanupDays)
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_MAX_AGE_DAYS
}

/** Limpia los registros vencidos de UNA empresa y guarda el resultado. */
export async function runCleanupForCompany(companyId: string, days: number): Promise<CleanupRunResult> {
  const col = getOperationsCollection()
  const cutoff = new Date(Date.now() - days * DAY_MS)
  const result: CleanupRunResult = {
    at: new Date().toISOString(), days, operationsDeleted: 0, filesDeleted: 0, keptShared: 0,
  }

  try {
    // createdAt puede estar como texto ISO (lo normal) o como Date: en Mongo
    // `$lt` no compara texto con fecha, así que se cubren ambos tipos.
    const oldOps = await col.find({
      companyId,
      $or: [
        { createdAt: { $lt: cutoff.toISOString() } },
        { createdAt: { $lt: cutoff } },
      ],
    }).toArray()

    if (oldOps.length > 0) {
      // Archivos que siguen usando los registros que NO se borran. Si no se
      // puede calcular, no se borra nada (borrar a ciegas dejaba sin fotos a
      // registros vigentes vinculados).
      const deleteSet = oldOps.map((o) => o.trackingCode as string)
      const stillUsed = await referencedPhotoIdsExcept({ companyId, excludeOps: deleteSet })

      for (const op of oldOps) {
        const trackingCode = op.trackingCode as string

        // 1) Cada foto (R2 y/o GitHub), salvo las compartidas. Se borra foto
        //    por foto (por su key): las carpetas `<tipo>_<placa>/` las comparten
        //    varios registros de la misma placa, así que NO se borra por carpeta.
        for (const ph of collectPhotos(op as Record<string, unknown>)) {
          if (isPhotoShared(ph, stillUsed)) { result.keptShared++; continue }
          try {
            if (await deletePhotoStorage(ph)) result.filesDeleted++
          } catch (storageErr) {
            console.warn(`[cleanup] No se pudo eliminar foto de ${trackingCode}:`, storageErr instanceof Error ? storageErr.message : storageErr)
          }
        }

        // 2) El registro en MongoDB. (Si quedó algún archivo suelto, lo recoge
        //    el barrido de huérfanos.)
        await col.deleteOne({ trackingCode })
        result.operationsDeleted++
      }
    }

    console.log(`[cleanup] Empresa ${companyId}: ${result.operationsDeleted} registro(s) con más de ${days} días eliminados, ${result.filesDeleted} archivo(s) borrados${result.keptShared ? `, ${result.keptShared} foto(s) conservadas por estar vinculadas a registros vigentes` : ''}.`)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(`[cleanup] Empresa ${companyId}: error en la limpieza:`, err)
  }

  // Constancia de la ejecución (visible en Configuración).
  try {
    await getDb().collection('company_settings').updateOne(
      { companyId },
      { $set: { cleanupLastRun: result } },
    )
  } catch { /* no bloquea */ }

  return result
}

let lastOrphanSweep = 0

/** Los archivos de fotos de registros se nombran `OP-AAAAMMDD-NNN_…`. */
const OP_FILE_RE = /^(OP-\d{8}-\d+)_/

/**
 * Borra de R2 los archivos de fotos de registros que YA NO EXISTEN y que
 * superan la antigüedad indicada (restos de borrados que fallaron a medias).
 *
 * Solo considera archivos cuyo NOMBRE empieza por un código de registro
 * (`OP-AAAAMMDD-NNN_`): así nunca toca imágenes del catálogo, subidas de
 * WhatsApp ni archivos de otras secciones. Además exige que ninguna foto de
 * ningún registro lo referencie.
 */
export async function sweepOrphanFiles(minAgeDays: number): Promise<number> {
  const { isStorageConfigured, listObjects, deleteObject } = await import('../lib/storage.js')
  if (!isStorageConfigured()) return 0

  const ageDays = Math.max(ORPHAN_MIN_AGE_DAYS, minAgeDays)
  const cutoffMs = Date.now() - ageDays * DAY_MS

  // Registros existentes y todos los archivos que alguna foto referencia.
  const existing = new Set<string>()
  for await (const op of getOperationsCollection().find({}, { projection: { _id: 0, trackingCode: 1 } })) {
    if (op.trackingCode) existing.add(String(op.trackingCode))
  }
  const refs = await referencedPhotoIdsExcept({})

  let deleted = 0
  for await (const obj of listObjects('')) {
    if (!obj.key || !obj.lastModified || obj.lastModified.getTime() >= cutoffMs) continue
    const fileName = obj.key.split('/').pop() ?? ''
    const tc = OP_FILE_RE.exec(fileName)?.[1]
    if (!tc || existing.has(tc)) continue
    if (refs.has(obj.key)) continue
    let referenced = false
    for (const id of refs) { if (id.endsWith(`/${obj.key}`)) { referenced = true; break } }
    if (referenced) continue
    try {
      await deleteObject(obj.key)
      deleted++
    } catch (e) {
      console.warn(`[cleanup] No se pudo borrar el huérfano ${obj.key}:`, e instanceof Error ? e.message : e)
    }
  }
  if (deleted) console.log(`[cleanup] ${deleted} archivo(s) huérfano(s) con más de ${ageDays} días eliminados de R2.`)
  return deleted
}

/** Barrido completo: todas las empresas con la limpieza activa + huérfanos. */
export async function runCleanupOldOperations(): Promise<{ deleted: number; skipped: string }> {
  try {
    const allSettings = await getDb().collection('company_settings').find({ cleanupEnabled: true }).toArray()
    if (allSettings.length === 0) {
      return { deleted: 0, skipped: 'Limpieza deshabilitada para todas las empresas.' }
    }

    let totalDeleted = 0
    let minDays = Infinity
    for (const setting of allSettings) {
      const companyId = setting.companyId as string
      if (!companyId) continue
      const days = daysOf(setting)
      minDays = Math.min(minDays, days)
      const r = await runCleanupForCompany(companyId, days)
      totalDeleted += r.operationsDeleted
    }

    // Huérfanos: como mucho una vez al día.
    if (Number.isFinite(minDays) && Date.now() - lastOrphanSweep >= ORPHAN_SWEEP_EVERY_MS) {
      lastOrphanSweep = Date.now()
      try { await sweepOrphanFiles(minDays) } catch (e) {
        console.warn('[cleanup] Error en el barrido de huérfanos:', e instanceof Error ? e.message : e)
      }
    }

    return { deleted: totalDeleted, skipped: '' }
  } catch (err) {
    console.error('[cleanup] Error en limpieza automática:', err)
    return { deleted: 0, skipped: 'Error interno.' }
  }
}

