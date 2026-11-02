import { Router } from 'express'
import { uploadToDrive, deletePhotoStorage } from '../lib/drive-upload.js'
import { getOperationsCollection } from '../lib/mongodb.js'
import { getStepsForType, MULTI_PHOTO_STEPS, OPTIONAL_STEPS, FREE_STEPS, PRODUCT_CODE_STEPS, OPTIONAL_PRODUCT_CODE_STEPS, normalizeClientTimestamp, type OperationType, type PhotoRecord } from '../types.js'
import { existingClientKeys, isDuplicateKey } from '../lib/photo-dedupe.js'

export const photosRouter = Router()

/**
 * DELETE /api/photos/:trackingCode/:photoIndex
 * Elimina una foto individual por su índice.
 */
photosRouter.delete('/:trackingCode/:photoIndex', async (req, res) => {
  const { trackingCode, photoIndex } = req.params
  const idx = Number(photoIndex)

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const photos = (operation.photos as PhotoRecord[]) ?? []
    if (idx < 0 || idx >= photos.length) { res.status(400).json({ message: 'Índice de foto inválido.' }); return }

    const photo = photos[idx]
    await deletePhotoStorage(photo)

    photos.splice(idx, 1)
    await col.updateOne({ trackingCode }, { $set: { photos, updatedAt: new Date().toISOString() } })
    res.json({ message: 'Foto eliminada.', remaining: photos.length })
  } catch (err) {
    console.error('[photos] Error al eliminar:', err)
    res.status(500).json({ message: 'Error al eliminar la foto.' })
  }
})

/**
 * PATCH /api/photos/:trackingCode/:photoIndex
 * Edita el comentario de una foto.
 */
photosRouter.patch('/:trackingCode/:photoIndex', async (req, res) => {
  const { trackingCode, photoIndex } = req.params
  const { comment } = req.body ?? {}
  const idx = Number(photoIndex)

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const photos = (operation.photos as PhotoRecord[]) ?? []
    if (idx < 0 || idx >= photos.length) { res.status(400).json({ message: 'Índice de foto inválido.' }); return }

    photos[idx].comment = comment?.trim() ?? photos[idx].comment
    if (req.body.fileId) photos[idx].fileId = req.body.fileId
    if (req.body.driveUrl) photos[idx].driveUrl = req.body.driveUrl
    await col.updateOne({ trackingCode }, { $set: { photos, updatedAt: new Date().toISOString() } })
    res.json({ message: 'Foto actualizada.', photo: photos[idx] })
  } catch (err) {
    console.error('[photos] Error al editar comentario:', err)
    res.status(500).json({ message: 'Error al actualizar comentario.' })
  }
})

/**
 * POST /api/photos/upload
 */
photosRouter.post('/upload', async (req, res) => {
  const { trackingCode, stepIndex, base64Image, mimeType, productCode, comment, clientTimestamp, groupId, clientKey } = req.body ?? {}

  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  if (stepIndex === undefined || stepIndex === null) { res.status(400).json({ message: 'stepIndex es requerido.' }); return }
  if (!base64Image) { res.status(400).json({ message: 'base64Image es requerido.' }); return }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    // Dedupe idempotente: si ya existe una foto con este clientKey, no insertar
    // de nuevo (reintentos / envíos concurrentes). Se devuelve la ya guardada.
    if (clientKey) {
      const existing = ((operation.photos as PhotoRecord[]) ?? []).find((p) => p.clientKey === clientKey)
      if (existing) {
        res.json({ message: 'Foto ya registrada (idempotente).', photo: existing, duplicate: true, progress: { current: 0, total: 1 } })
        return
      }
    }

    const opType = operation.operationType as OperationType
    const steps = getStepsForType(opType)
    const idx = Number(stepIndex)
    if (idx < 0 || idx >= steps.length) { res.status(400).json({ message: `stepIndex inválido (0-${steps.length - 1}).` }); return }

    const isMultiPhotoStep = MULTI_PHOTO_STEPS[opType]?.includes(idx) ?? false

    const existingPhotos = (operation.photos as PhotoRecord[]) ?? []
    const optionalSteps = OPTIONAL_STEPS[opType] ?? []
    const freeSteps = FREE_STEPS[opType] ?? []

    // Pasos libres (acontecimiento): sin restricción de secuencia
    // Otros pasos: verifica secuencia buscando el paso requerido anterior
    if (idx > 0 && !freeSteps.includes(idx) && !optionalSteps.includes(idx)) {
      let requiredPrev = idx - 1
      while (requiredPrev >= 0 && (optionalSteps.includes(requiredPrev) || freeSteps.includes(requiredPrev))) {
        requiredPrev--
      }
      if (requiredPrev >= 0 && !existingPhotos.some((p) => p.stepIndex === requiredPrev)) {
        res.status(400).json({ message: `Debes completar "${steps[requiredPrev]}" antes.` }); return
      }
    }

    const alreadyExists = !isMultiPhotoStep && existingPhotos.some((p) => p.stepIndex === idx)
    const photoIndex = existingPhotos.filter((p) => p.stepIndex === idx).length

    let subfolderName = operation.vehiclePlate
      ? `${operation.operationType}_${operation.vehiclePlate}`
      : `${operation.operationType}_${trackingCode}`
    const subSubfolderName = productCode?.trim() || undefined

    const stepName = steps[idx]!
    const cleanStepName = stepName.replace(/[^a-zA-Z0-9]/g, '_')
    const suffix = isMultiPhotoStep ? `_${photoIndex + 1}` : ''
    const productSuffix = productCode?.trim() ? `_${productCode.trim()}` : ''
    const fileName = `${trackingCode}_paso${idx + 1}_${cleanStepName}${productSuffix}${suffix}.jpg`

    const driveResult = await uploadToDrive({ base64Image, fileName, mimeType: mimeType || 'image/jpeg', subfolderName, subSubfolderName, companyId: operation.companyId as string | undefined })

    let fileId = driveResult.fileId ?? ''
    let driveUrl = driveResult.driveUrl ?? ''

    if (driveResult.status === 'error') {
      if ((driveResult.message ?? '').includes('no configurado')) {
        res.status(502).json({ message: 'Almacenamiento no configurado en el servidor (R2 o GitHub).' }); return
      }
      fileId = fileId || 'pending'
      driveUrl = driveUrl || 'pending-verification'
    }

    const photoRecord: PhotoRecord = {
      stepIndex: idx, stepName, driveUrl, fileId,
      ...(productCode?.trim() ? { productCode: productCode.trim() } : {}),
      ...(isMultiPhotoStep ? { photoIndex } : {}),
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
      ...(groupId ? { groupId: String(groupId) } : {}),
      ...(clientKey ? { clientKey: String(clientKey) } : {}),
      photoType: 'proceso',
      timestamp: normalizeClientTimestamp(clientTimestamp),
    }

    if (alreadyExists && !isMultiPhotoStep) {
      await col.updateOne({ trackingCode, 'photos.stepIndex': idx }, { $set: { 'photos.$': photoRecord, updatedAt: new Date().toISOString() } })
    } else {
      await col.updateOne({ trackingCode }, { $push: { photos: photoRecord }, $set: { updatedAt: new Date().toISOString() } } as unknown as Record<string, unknown>)
    }

    const updatedOp = await col.findOne({ trackingCode })
    const updatedPhotos = (updatedOp?.photos as PhotoRecord[]) ?? []
    const completedStepIndexes = new Set(updatedPhotos.map((p) => p.stepIndex))

    res.json({ message: 'Foto registrada correctamente.', photo: photoRecord, progress: { current: completedStepIndexes.size, total: steps.length, totalPhotos: updatedPhotos.length, completed: false } })
  } catch (err) {
    console.error('[photos] Error:', err)
    res.status(500).json({ message: 'Error interno al procesar la foto.' })
  }
})

/**
 * POST /api/photos/upload-batch
 * Sube VARIAS fotos de una misma tanda (groupId) y las guarda con UN solo $push
 * ($each), evitando la condición de carrera que perdía fotos al subirlas en
 * paralelo. Body: { trackingCode, groupId?, comment?, clientTimestamp?, mimeType?,
 * photos: [{ base64Image, comment?, clientTimestamp? }] }
 */
photosRouter.post('/upload-batch', async (req, res) => {
  const { trackingCode, groupId, comment, clientTimestamp, mimeType, photos } = req.body ?? {}

  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  if (!Array.isArray(photos) || photos.length === 0) { res.status(400).json({ message: 'photos (arreglo) es requerido.' }); return }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const opType = operation.operationType as OperationType
    const steps = getStepsForType(opType)
    const idx = 0
    const stepName = steps[idx]!
    const cleanStepName = stepName.replace(/[^a-zA-Z0-9]/g, '_')

    const subfolderName = operation.vehiclePlate
      ? `${operation.operationType}_${operation.vehiclePlate}`
      : `${operation.operationType}_${trackingCode}`

    const existingPhotos = (operation.photos as PhotoRecord[]) ?? []
    // Claves de idempotencia ya presentes, para no re-subir duplicados.
    const existingKeys = existingClientKeys(existingPhotos)
    let photoIndex = existingPhotos.filter((p) => p.stepIndex === idx).length

    const records: PhotoRecord[] = []
    const errors: string[] = []
    let skipped = 0

    // Subir en SECUENCIA y acumular; un solo $push al final.
    for (let i = 0; i < photos.length; i++) {
      const item = photos[i] ?? {}
      const base64Image = item.base64Image
      if (!base64Image) { errors.push(`Foto ${i + 1}: sin imagen`); continue }

      // Dedupe idempotente por clientKey (reintentos de red / envíos repetidos).
      const itemKey = item.clientKey ? String(item.clientKey) : ''
      if (isDuplicateKey(existingKeys, itemKey)) { skipped++; continue }

      const fileName = `${trackingCode}_paso${idx + 1}_${cleanStepName}_${photoIndex + 1}.jpg`
      const driveResult = await uploadToDrive({
        base64Image,
        fileName,
        mimeType: mimeType || 'image/jpeg',
        subfolderName,
        companyId: operation.companyId as string | undefined,
      })

      if (driveResult.status === 'error' && (driveResult.message ?? '').includes('no configurado')) {
        res.status(502).json({ message: 'Almacenamiento no configurado en el servidor (R2 o GitHub).' }); return
      }

      const fileId = driveResult.fileId || 'pending'
      const driveUrl = driveResult.driveUrl || 'pending-verification'
      // El comentario del grupo va en la primera foto (o el de la foto si viene).
      const photoComment = (item.comment ?? (i === 0 ? comment : '') ?? '').trim()

      records.push({
        stepIndex: idx,
        stepName,
        driveUrl,
        fileId,
        photoIndex,
        ...(photoComment ? { comment: photoComment } : {}),
        ...(groupId ? { groupId: String(groupId) } : {}),
        ...(itemKey ? { clientKey: itemKey } : {}),
        photoType: 'proceso',
        timestamp: normalizeClientTimestamp(item.clientTimestamp ?? clientTimestamp),
      })
      if (itemKey) existingKeys.add(itemKey)
      photoIndex++
    }

    if (records.length === 0) {
      // Si todo se omitió por idempotencia, es un reintento ya aplicado: 200.
      if (skipped > 0) { res.json({ message: 'Fotos ya registradas (idempotente).', count: 0, skipped, errors }); return }
      res.status(422).json({ message: 'No se pudo procesar ninguna foto.', errors }); return
    }

    // UN SOLO push con todas las fotos del grupo (evita carrera).
    await col.updateOne(
      { trackingCode },
      { $push: { photos: { $each: records } }, $set: { updatedAt: new Date().toISOString() } } as unknown as Record<string, unknown>,
    )

    res.json({ message: `${records.length} foto(s) registrada(s).`, count: records.length, skipped, errors })
  } catch (err) {
    console.error('[photos] Error en upload-batch:', err)
    res.status(500).json({ message: 'Error interno al procesar las fotos.' })
  }
})

/**
 * POST /api/photos/note
 * Agrega un comentario/nota sin imagen al registro (mensaje de solo texto).
 */
photosRouter.post('/note', async (req, res) => {
  const { trackingCode, comment, clientTimestamp } = req.body ?? {}
  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  if (!comment?.trim()) { res.status(400).json({ message: 'comment es requerido.' }); return }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const noteRecord: PhotoRecord = {
      stepIndex: 0,
      stepName: 'Nota',
      driveUrl: '',
      fileId: 'note',
      comment: comment.trim(),
      photoType: 'proceso',
      timestamp: normalizeClientTimestamp(clientTimestamp),
    }

    await col.updateOne(
      { trackingCode },
      { $push: { photos: noteRecord }, $set: { updatedAt: new Date().toISOString() } } as unknown as Record<string, unknown>,
    )

    res.json({ message: 'Nota agregada.', photo: noteRecord })
  } catch (err) {
    console.error('[photos] Error al agregar nota:', err)
    res.status(500).json({ message: 'Error al agregar la nota.' })
  }
})

/**
 * POST /api/photos/sync/:trackingCode
 * OBSOLETO desde la migración a R2.
 *
 * Antes servía para recuperar los fileId de Drive cuando una subida quedaba
 * "pending". Con R2 la subida es síncrona y la foto queda con su URL final al
 * instante, así que no hay nada que sincronizar. Se mantiene el endpoint para
 * no romper el frontend que aún lo invoca; responde de forma idempotente.
 */
photosRouter.post('/sync/:trackingCode', async (req, res) => {
  const { trackingCode } = req.params
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }
    res.json({ message: 'Las fotos ya están sincronizadas (almacenamiento en la nube).', filesInDrive: 0, updated: 0 })
  } catch (err) {
    console.error('[photos/sync] Error:', err)
    res.status(500).json({ message: 'Error al sincronizar.' })
  }
})

