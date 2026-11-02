/**
 * Subida de imágenes — ahora respaldada por Cloudflare R2 (antes Google Drive).
 *
 * Se mantiene la firma `uploadToDrive(payload) → DriveUploadResult` para no tocar
 * los call sites existentes (routes/photos.ts, routes/operations.ts). Internamente
 * la imagen se sube a R2 vía lib/storage.ts.
 *
 * Mapeo de campos (compatibilidad con el modelo existente):
 *   - fileId   → key del objeto en R2 (ej. operations/<trackingCode>/<archivo>.jpg)
 *   - driveUrl → URL de la imagen en R2 (pública o firmada)
 *
 * El parámetro subfolderName/subSubfolderName se usa para construir el prefijo
 * de la key, preservando la organización por operación/producto.
 */

import { uploadImage, isStorageConfigured } from './storage.js'
import { isGitHubConfigured, uploadImageToGitHub } from './github-storage.js'

export interface DriveUploadResult {
  status: 'success' | 'error'
  fileId?: string      // key de R2
  driveUrl?: string    // URL de R2
  downloadUrl?: string
  thumbnailUrl?: string
  message?: string
}

export interface DriveUploadPayload {
  base64Image: string
  fileName: string
  mimeType: string
  subfolderName: string
  subSubfolderName?: string   // Subcarpeta lógica (código de producto)
  companyId?: string
}

export async function uploadToDrive(payload: DriveUploadPayload): Promise<DriveUploadResult> {
  // Prefijo de key/carpeta lógica: <subfolder>/<subSubfolder?>
  const parts = [payload.subfolderName]
  if (payload.subSubfolderName) parts.push(payload.subSubfolderName)
  const keyPrefix = parts
    .map((p) => p.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/')

  // 1. Preferir Cloudflare R2 (object storage real) si está configurado.
  if (isStorageConfigured()) {
    try {
      const result = await uploadImage(payload.base64Image, {
        contentType: payload.mimeType || 'image/jpeg',
        keyPrefix,
        fileName: payload.fileName,
      })
      console.log(`[storage] ✓ Subido a R2: ${result.key}`)
      return {
        status: 'success',
        fileId: result.key,
        driveUrl: result.url,
        downloadUrl: result.url,
        thumbnailUrl: result.url,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      console.error('[storage] Error al subir a R2:', message)
      return { status: 'error', message }
    }
  }

  // 2. Fallback a GitHub si está configurado.
  if (isGitHubConfigured()) {
    try {
      const gh = await uploadImageToGitHub(payload.base64Image, {
        path: keyPrefix,
        fileName: payload.fileName,
        ext: (payload.mimeType || '').includes('png') ? 'png' : 'jpg',
      })
      console.log(`[storage] ✓ Subido a GitHub: ${gh.path}`)
      return {
        status: 'success',
        fileId: gh.path,       // la key/ruta de GitHub ocupa el lugar del antiguo fileId
        driveUrl: gh.rawUrl,   // URL raw.githubusercontent.com
        downloadUrl: gh.rawUrl,
        thumbnailUrl: gh.rawUrl,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      console.error('[storage] Error al subir a GitHub:', message)
      return { status: 'error', message }
    }
  }

  // 3. Ninguno configurado.
  console.warn('[storage] Sin almacenamiento configurado (R2 ni GitHub).')
  return { status: 'error', message: 'Almacenamiento no configurado. Define las variables R2_* o GITHUB_* en el servidor.' }
}

/**
 * Borra el archivo de una foto de su almacenamiento (R2 y/o GitHub), según la
 * referencia disponible (fileId key o driveUrl). Best-effort, no lanza.
 */
export async function deletePhotoStorage(photo: { fileId?: string; driveUrl?: string }): Promise<void> {
  const fileId = photo.fileId
  const driveUrl = photo.driveUrl
  // R2: fileId es una key (sin ser 'pending'/'note').
  if (fileId && fileId !== 'pending' && fileId !== 'note') {
    try {
      const { deleteObject } = await import('./storage.js')
      await deleteObject(fileId)
    } catch (e) { console.warn('[storage] Error al eliminar de R2:', e instanceof Error ? e.message : e) }
  }
  // GitHub: por rawUrl o por fileId-path.
  const ref = (driveUrl && driveUrl.includes('raw.githubusercontent.com')) ? driveUrl : (fileId ?? '')
  if (ref) {
    try {
      const { deleteImageFromGitHub } = await import('./github-storage.js')
      await deleteImageFromGitHub(ref)
    } catch (e) { console.warn('[storage] Error al eliminar de GitHub:', e instanceof Error ? e.message : e) }
  }
}
