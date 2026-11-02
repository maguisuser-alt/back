/**
 * Rutas administrativas del dominio TRAZABILIDAD (sin token, igual que antes).
 * Portadas desde el server.ts original de trasabilidad-product/backend.
 */
import { Router } from 'express'
import { asyncHandler } from '../../../core/http.js'
import { getDb, getOperationsCollection } from '../lib/mongodb.js'
import { runCleanupOldOperations } from '../jobs/cleanupOldOperations.js'

export const adminRouter = Router()

// Endpoint manual de limpieza (útiles para cron externo, p. ej. cron-job.org).
adminRouter.post('/cleanup', asyncHandler(async (_req, res) => {
  res.json(await runCleanupOldOperations())
}))
adminRouter.get('/cleanup', asyncHandler(async (_req, res) => {
  res.json(await runCleanupOldOperations())
}))

/**
 * GET /cleanup/list → lista las carpetas de trazabilidad en la papelera de Drive.
 */
adminRouter.get('/recover/list', asyncHandler(async (_req, res) => {
  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
  if (!GAS_URL) { res.status(502).json({ message: 'GAS_WEBHOOK_URL no configurado.' }); return }
  const url = `${GAS_URL}?action=listTrashed`
  const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  const data = await response.json() as { status: string; folders?: unknown[]; message?: string }
  res.json(data)
}))

/**
 * POST /recover/restore → restaura una carpeta de la papelera y reconstruye la
 * operación en MongoDB. Body: { folderId, companyId?, operatorName? }
 */
adminRouter.post('/recover/restore', asyncHandler(async (req, res) => {
  const { folderId, companyId, operatorName } = req.body ?? {}
  if (!folderId) { res.status(400).json({ message: 'folderId es requerido.' }); return }
  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
  if (!GAS_URL) { res.status(502).json({ message: 'GAS_WEBHOOK_URL no configurado.' }); return }

  // 1. Restaurar la carpeta en Drive vía GAS
  const restoreUrl = `${GAS_URL}?action=restoreFolder&folderId=${encodeURIComponent(folderId)}`
  const restoreResp = await fetch(restoreUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  const restoreData = await restoreResp.json() as {
    status: string
    folder?: { id: string; name: string; files: Array<{ fileName: string; fileId: string }>; subfolders: Record<string, Array<{ fileName: string; fileId: string }>> }
    message?: string
  }

  if (restoreData.status !== 'success' || !restoreData.folder) {
    res.status(500).json({ message: restoreData.message ?? 'No se pudo restaurar la carpeta.' }); return
  }

  const folder = restoreData.folder
  const folderName = folder.name // ej: PRODUCTOS_ENTRANTES_ABC123 o PRODUCTOS_SALIENTES_KJI000

  // 2. Parsear el nombre de la carpeta para reconstruir la operación
  const parts = folderName.split('_')
  const operationType = parts[0] === 'PRODUCTOS' && parts[1] === 'ENTRANTES'
    ? 'PRODUCTOS_ENTRANTES'
    : parts[0] === 'PRODUCTOS' && parts[1] === 'SALIENTES'
      ? 'PRODUCTOS_SALIENTES'
      : 'PRODUCTOS_ENTRANTES'
  const vehiclePlate = parts.length > 2 ? parts.slice(2).join('_') : undefined

  // 3. Reconstruir fotos generales desde archivos de la carpeta raíz
  const photos = folder.files.map((f) => ({
    stepIndex: 0,
    stepName: 'Registro fotográfico',
    driveUrl: `https://drive.google.com/file/d/${f.fileId}/view?usp=sharing`,
    fileId: f.fileId,
    photoType: 'proceso' as const,
    timestamp: new Date().toISOString(),
    comment: f.fileName,
  }))

  // 4. Reconstruir productos (subcarpetas) con sus fotos
  const lineaBlanca = Object.entries(folder.subfolders).map(([productCode, productFiles]) => ({
    productCode,
    photos: productFiles.map((f) => ({
      stepIndex: 0,
      stepName: 'Registro fotográfico',
      driveUrl: `https://drive.google.com/file/d/${f.fileId}/view?usp=sharing`,
      fileId: f.fileId,
      productCode,
      photoType: 'proceso' as const,
      timestamp: new Date().toISOString(),
      comment: f.fileName,
    })),
    status: 'EN_PROCESO' as const,
    createdAt: new Date().toISOString(),
    isLineaBlanca: false,
  }))

  // 5. Generar un trackingCode y reconstruir el documento en MongoDB
  const col = getOperationsCollection()

  // Usa el folderId como parte del tracking code para evitar duplicados
  const shortId = folderId.slice(-8)
  const trackingCode = `REC-${shortId}`

  const existing = await col.findOne({ trackingCode })
  if (existing) {
    res.json({ message: `La operación ${trackingCode} ya fue restaurada anteriormente.`, trackingCode, alreadyExists: true })
    return
  }

  const now = new Date().toISOString()
  const operation = {
    trackingCode,
    operationType,
    operatorName: operatorName || 'Recuperado',
    ...(vehiclePlate ? { vehiclePlate } : {}),
    ...(companyId ? { companyId } : {}),
    photos,
    lineaBlanca,
    status: 'EN_PROCESO' as const,
    createdAt: now,
    updatedAt: now,
    recoveredFrom: { folderId, folderName, recoveredAt: now },
  }

  await col.insertOne(operation)
  res.json({ message: `Operación ${trackingCode} recuperada con ${photos.length} fotos y ${lineaBlanca.length} producto(s).`, trackingCode, operation })
}))

/**
 * POST /recover/import-all → lee todas las carpetas activas de Drive (no en
 * papelera) y las importa a MongoDB si no existen ya. Body: { companyId?, parentFolderId?, operatorName? }
 */
adminRouter.post('/recover/import-all', asyncHandler(async (req, res) => {
  const { companyId, parentFolderId, operatorName } = req.body ?? {}
  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
  if (!GAS_URL) { res.status(502).json({ message: 'GAS_WEBHOOK_URL no configurado.' }); return }

  // 1. Obtener la parentFolderId de la empresa si no viene en el body
  let resolvedParentFolderId = parentFolderId ?? ''
  if (!resolvedParentFolderId && companyId) {
    const settings = await getDb().collection('company_settings').findOne({ companyId })
    if (settings?.driveFolderId) resolvedParentFolderId = settings.driveFolderId as string
  }

  // 2. Listar carpetas activas de Drive
  const listUrl = `${GAS_URL}?action=listActiveFolders${resolvedParentFolderId ? `&parentFolderId=${encodeURIComponent(resolvedParentFolderId)}` : ''}`
  const listResp = await fetch(listUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  const listData = await listResp.json() as {
    status: string
    folders?: Array<{ id: string; name: string; files: Array<{ fileName: string; fileId: string }>; subfolders: Record<string, Array<{ fileName: string; fileId: string }>> }>
    message?: string
  }

  if (listData.status !== 'success' || !listData.folders) {
    res.status(500).json({ message: listData.message ?? 'No se pudieron listar las carpetas de Drive.' }); return
  }

  const col = getOperationsCollection()
  const results: Array<{ trackingCode: string; folderName: string; status: string; photos: number; products: number }> = []

  for (const folder of listData.folders) {
    const folderName = folder.name
    const parts = folderName.split('_')
    const operationType = parts[0] === 'PRODUCTOS' && parts[1] === 'ENTRANTES'
      ? 'PRODUCTOS_ENTRANTES'
      : 'PRODUCTOS_SALIENTES'
    const vehiclePlate = parts.length > 2 ? parts.slice(2).join('_') : undefined

    // Genera un trackingCode basado en el folderId (determinista, sin duplicados)
    const shortId = folder.id.slice(-8)
    const trackingCode = `REC-${shortId}`

    const existing = await col.findOne({ trackingCode })
    if (existing) {
      results.push({ trackingCode, folderName, status: 'ya_existe', photos: folder.files.length, products: Object.keys(folder.subfolders).length })
      continue
    }

    const now = new Date().toISOString()
    const photos = folder.files.map((f) => ({
      stepIndex: 0, stepName: 'Registro fotográfico',
      driveUrl: `https://drive.google.com/file/d/${f.fileId}/view?usp=sharing`,
      fileId: f.fileId, photoType: 'proceso' as const,
      timestamp: now, comment: f.fileName,
    }))

    const lineaBlanca = Object.entries(folder.subfolders).map(([productCode, productFiles]) => ({
      productCode,
      photos: productFiles.map((f) => ({
        stepIndex: 0, stepName: 'Registro fotográfico',
        driveUrl: `https://drive.google.com/file/d/${f.fileId}/view?usp=sharing`,
        fileId: f.fileId, productCode, photoType: 'proceso' as const,
        timestamp: now, comment: f.fileName,
      })),
      status: 'EN_PROCESO' as const,
      createdAt: now, isLineaBlanca: false,
    }))

    await col.insertOne({
      trackingCode, operationType,
      operatorName: operatorName || 'Recuperado',
      ...(vehiclePlate ? { vehiclePlate } : {}),
      ...(companyId ? { companyId } : {}),
      photos, lineaBlanca,
      status: 'EN_PROCESO' as const,
      createdAt: now, updatedAt: now,
      recoveredFrom: { folderId: folder.id, folderName, recoveredAt: now },
    })

    results.push({ trackingCode, folderName, status: 'importado', photos: photos.length, products: lineaBlanca.length })
  }

  const importados = results.filter((r) => r.status === 'importado').length
  const yaExistian = results.filter((r) => r.status === 'ya_existe').length
  res.json({ message: `${importados} registro(s) importado(s). ${yaExistian} ya existían.`, results })
}))
