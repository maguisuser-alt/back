/**
 * Rutas de subida de archivos (imágenes, audio, documentos).
 *
 *  - POST /api/uploads/image
 *      Body: { base64, mimeType?, fileName?, companyId? }
 *      Sube la imagen y devuelve su URL pública. Usa Cloudflare R2 si está
 *      configurado; si no, cae a GitHub (raw.githubusercontent.com). Si ninguno
 *      está configurado, responde 502 con un mensaje claro.
 *
 *  - POST /api/uploads/file
 *      Body: { base64, mimeType, fileName, companyId? }
 *      Sube un archivo genérico (audio, PDF, documento) y devuelve su URL.
 *      Útil para adjuntos de audio y documentos estilo WhatsApp.
 */

import { Router } from 'express'
import { isStorageConfigured, uploadImage } from '../lib/storage.js'
import { isGitHubConfigured, uploadImageToGitHub } from '../lib/github-storage.js'

export const uploadsRouter = Router()

/** Infiera una extensión desde el mimeType para nombrar el archivo. */
function extFromMime(mimeType?: string): string {
  const m = (mimeType ?? '').toLowerCase()
  if (m.includes('pdf')) return 'pdf'
  if (m.includes('msword') || m.includes('word')) return 'doc'
  if (m.includes('sheet') || m.includes('excel')) return 'xlsx'
  if (m.includes('powerpoint') || m.includes('presentation')) return 'pptx'
  if (m.includes('zip')) return 'zip'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('webm')) return 'webm'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  return 'bin'
}

uploadsRouter.post('/image', async (req, res) => {
  const { base64, mimeType, fileName, companyId } = req.body ?? {}
  if (!base64) { res.status(400).json({ message: '"base64" (imagen) es requerido.' }); return }

  const prefix = `uploads/${companyId ?? 'general'}`

  try {
    // 1. Preferir R2 (object storage real).
    if (isStorageConfigured()) {
      const up = await uploadImage(base64, {
        contentType: mimeType || 'image/jpeg',
        keyPrefix: prefix,
        fileName,
      })
      res.json({ message: 'Imagen subida.', url: up.url, storage: 'r2', key: up.key, public: up.public })
      return
    }

    // 2. Fallback a GitHub.
    if (isGitHubConfigured()) {
      const gh = await uploadImageToGitHub(base64, { path: prefix, fileName })
      res.json({ message: 'Imagen subida.', url: gh.rawUrl, storage: 'github', key: gh.path, public: true })
      return
    }

    res.status(502).json({ message: 'No hay almacenamiento configurado (define R2_* o GITHUB_* en el servidor).' })
  } catch (err) {
    console.error('[uploads] Error al subir imagen:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo subir la imagen.' })
  }
})

uploadsRouter.post('/file', async (req, res) => {
  const { base64, mimeType, fileName, companyId } = req.body ?? {}
  if (!base64) { res.status(400).json({ message: '"base64" es requerido.' }); return }
  if (!mimeType) { res.status(400).json({ message: '"mimeType" es requerido.' }); return }

  const prefix = `uploads/${companyId ?? 'general'}`
  const ext = extFromMime(mimeType)

  try {
    // 1. Preferir R2 (object storage real).
    if (isStorageConfigured()) {
      const up = await uploadImage(base64, {
        contentType: mimeType,
        keyPrefix: prefix,
        fileName: fileName || undefined,
      })
      res.json({ message: 'Archivo subido.', url: up.url, storage: 'r2', key: up.key, public: up.public })
      return
    }

    // 2. Fallback a GitHub.
    if (isGitHubConfigured()) {
      const gh = await uploadImageToGitHub(base64, { path: prefix, fileName, ext })
      res.json({ message: 'Archivo subido.', url: gh.rawUrl, storage: 'github', key: gh.path, public: true })
      return
    }

    res.status(502).json({ message: 'No hay almacenamiento configurado (define R2_* o GITHUB_* en el servidor).' })
  } catch (err) {
    console.error('[uploads] Error al subir archivo:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo subir el archivo.' })
  }
})
