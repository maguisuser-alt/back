/**
 * Job de limpieza automática configurable:
 * - Solo corre si la empresa tiene cleanupEnabled = true en su configuración.
 * - Respeta cleanupDays (días antes de eliminar, default 20).
 * - Elimina las imágenes de la operación en R2 (por prefijo) y en GitHub
 *   (una por una, usando la referencia guardada). deletePhotoStorage ya borra
 *   de ambos almacenamientos según corresponda.
 * - Se puede activar/desactivar y configurar desde la app en Configuración.
 */
import { getOperationsCollection, getDb } from '../lib/mongodb.js'
import { deletePhotoStorage } from '../lib/drive-upload.js'

const DEFAULT_MAX_AGE_DAYS = 20

type PhotoRef = { driveUrl?: string; fileId?: string }

function collectPhotos(op: Record<string, unknown>): PhotoRef[] {
  const refs: PhotoRef[] = []
  const push = (ph: PhotoRef) => {
    if (ph && (ph.driveUrl || ph.fileId)) refs.push(ph)
  }

  const general = (op.photos as PhotoRef[]) ?? []
  for (const ph of general) push(ph)

  const products = (op.lineaBlanca as Array<{ photos?: PhotoRef[] }>) ?? []
  for (const prod of products) {
    for (const ph of prod.photos ?? []) push(ph)
  }

  return refs
}

export async function runCleanupOldOperations(): Promise<{ deleted: number; skipped: string }> {
  try {
    const col = getOperationsCollection()
    const db = getDb()

    const settingsCursor = db.collection('company_settings').find({ cleanupEnabled: true })
    const allSettings = await settingsCursor.toArray()

    if (allSettings.length === 0) {
      return { deleted: 0, skipped: 'Limpieza deshabilitada para todas las empresas.' }
    }

    let totalDeleted = 0

    for (const setting of allSettings) {
      const companyId = setting.companyId as string
      const days = typeof setting.cleanupDays === 'number' && setting.cleanupDays > 0
        ? setting.cleanupDays
        : DEFAULT_MAX_AGE_DAYS
      const maxAgeMs = days * 24 * 60 * 60 * 1000
      const cutoffISO = new Date(Date.now() - maxAgeMs).toISOString()

      const oldOps = await col.find({ companyId, createdAt: { $lt: cutoffISO } }).toArray()
      if (oldOps.length === 0) continue

      for (const op of oldOps) {
        const trackingCode = op.trackingCode as string

        // 1) Borrar cada foto de su almacenamiento (R2 y/o GitHub).
        //    deletePhotoStorage detecta por fileId/driveUrl de dónde viene.
        const photos = collectPhotos(op as Record<string, unknown>)
        for (const ph of photos) {
          try {
            await deletePhotoStorage(ph)
          } catch (storageErr) {
            console.warn(`[cleanup] No se pudo eliminar foto de ${trackingCode}:`, storageErr instanceof Error ? storageErr.message : storageErr)
          }
        }

        // 2) Best-effort: borrar por prefijo en R2 por si quedaran huérfanos.
        try {
          const { deleteByPrefix } = await import('../lib/storage.js')
          await deleteByPrefix(`operations/${trackingCode}/`)
        } catch { /* R2 puede no estar configurado */ }

        // 3) Eliminar de MongoDB
        await col.deleteOne({ trackingCode })
        totalDeleted++
      }

      console.log(`[cleanup] Empresa ${companyId}: ${oldOps.length} operación(es) con más de ${days} días eliminadas (R2 + GitHub).`)
    }

    return { deleted: totalDeleted, skipped: '' }
  } catch (err) {
    console.error('[cleanup] Error en limpieza automática:', err)
    return { deleted: 0, skipped: 'Error interno.' }
  }
}
