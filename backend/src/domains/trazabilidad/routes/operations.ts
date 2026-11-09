import { Router } from 'express'
import { getOperationsCollection, getProductsCatalogCollection, getMovementsCollection, getDb } from '../lib/mongodb.js'
import { generateTrackingCode } from '../lib/tracking-code.js'
import { uploadToDrive, deletePhotoStorage } from '../lib/drive-upload.js'
import { refreshPhotoUrls } from '../lib/storage.js'
import { sendOperationEmail } from '../lib/email.js'
import { getStepsForType, LINEA_BLANCA_STEPS, OPTIONAL_STEPS, normalizeClientTimestamp, type CompanyLocation, type LineaBlancaProduct, type LocationRef, type OperationType, type PhotoRecord } from '../types.js'
import { existingClientKeys, isDuplicateKey } from '../lib/photo-dedupe.js'
import { referencedPhotoIdsExcept, isPhotoShared, isPrefixReferenced } from '../lib/photo-refs.js'
import { readAllowed } from '../lib/features.js'
import { toLocationRef, recordMovement } from '../lib/locations.js'

/**
 * Lee los lugares configurados y si la función de lugares está habilitada para
 * la empresa. Si está deshabilitada, se ignora toda la información de ubicación.
 */
async function getCompanyLocationCtx(companyId: string | undefined): Promise<{ enabled: boolean; places: CompanyLocation[] }> {
  if (!companyId) return { enabled: false, places: [] }
  const doc = await getDb().collection('company_settings').findOne({ companyId }) as Record<string, unknown> | null
  const enabled = readAllowed(doc).locationsEnabled === true
  const places = Array.isArray(doc?.locations) ? (doc!.locations as CompanyLocation[]) : []
  return { enabled, places }
}

export const operationsRouter = Router()

/** Registra una entrada en el log de actividad de la empresa. */
async function logActivity(
  companyId: string | undefined,
  action: string,
  detail: string,
  meta?: Record<string, unknown>,
) {
  if (!companyId) return
  try {
    await getDb().collection('activity_log').insertOne({
      companyId,
      action,
      detail,
      meta: meta ?? {},
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[activity] Error al registrar:', err)
  }
}

/** Borra todas las fotos (R2+GitHub) de una lista de registros de foto. */
async function deleteAllPhotosStorage(photos: Array<{ fileId?: string; driveUrl?: string }>): Promise<void> {
  for (const ph of photos) await deletePhotoStorage(ph)
}

/**
 * Devuelve una copia de la operación con las URLs de sus fotos re-firmadas.
 *
 * Las URLs firmadas de R2 que se guardan en Mongo caducan (default 7 días), lo
 * que hacía que las fotos antiguas dejaran de cargar. Aquí se regenera la firma
 * a partir de la key (`fileId`) justo antes de responder, tanto para las fotos
 * del registro (`photos`) como para las de cada producto (`lineaBlanca`). Es
 * best-effort: si no hay R2 o hay base pública, devuelve la operación sin tocar.
 */
async function withFreshPhotoUrls<T extends Record<string, unknown>>(operation: T): Promise<T> {
  const photos = operation.photos as PhotoRecord[] | undefined
  const lineaBlanca = operation.lineaBlanca as LineaBlancaProduct[] | undefined

  const [freshPhotos, freshLineaBlanca] = await Promise.all([
    Array.isArray(photos) ? refreshPhotoUrls(photos) : Promise.resolve(photos),
    Array.isArray(lineaBlanca)
      ? Promise.all(lineaBlanca.map(async (p) => ({ ...p, photos: await refreshPhotoUrls(p.photos ?? []) })))
      : Promise.resolve(lineaBlanca),
  ])

  return { ...operation, photos: freshPhotos, lineaBlanca: freshLineaBlanca }
}

const VALID_TYPES: OperationType[] = ['PRODUCTOS_ENTRANTES', 'PRODUCTOS_SALIENTES', 'ACTIVIDAD']

/**
 * Registra (upsert) un producto en el catálogo maestro.
 * origin 'catalog' persiste siempre; 'registro' se borra cuando sale del último registro.
 * No degrada un 'catalog' existente a 'registro'.
 */
async function upsertCatalogProduct(companyId: string | undefined, productCode: string, descripcion: string | undefined, origin: 'catalog' | 'registro') {
  const code = productCode.trim()
  if (!code) return
  const catalog = getProductsCatalogCollection()
  const productCodeLower = code.toLowerCase()
  const existing = await catalog.findOne({ companyId: companyId ?? null, productCodeLower })
  if (existing) {
    // Mantiene el origin más "fuerte" (catalog). Actualiza descripción si llega una nueva.
    const set: Record<string, unknown> = {}
    if (descripcion?.trim()) set.descripcion = descripcion.trim()
    if (origin === 'catalog' && existing.origin !== 'catalog') set.origin = 'catalog'
    if (Object.keys(set).length > 0) await catalog.updateOne({ _id: existing._id }, { $set: set })
    return
  }
  await catalog.insertOne({
    companyId: companyId ?? null,
    productCode: code,
    productCodeLower,
    descripcion: descripcion?.trim() || undefined,
    origin,
    createdAt: new Date().toISOString(),
  })
}

/**
 * Al quitar un producto de un registro: si ya no queda en ningún otro registro
 * y su origen es 'registro', se elimina del catálogo. Si es 'catalog', permanece.
 */
async function cleanupCatalogIfOrphan(companyId: string | undefined, productCode: string) {
  const code = productCode.trim()
  if (!code) return
  const ops = getOperationsCollection()
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const filter: Record<string, unknown> = { 'lineaBlanca.productCode': { $regex: `^${escaped}$`, $options: 'i' } }
  if (companyId) filter.companyId = companyId
  const stillUsed = await ops.findOne(filter)
  if (stillUsed) return // sigue en algún registro → no tocar

  const catalog = getProductsCatalogCollection()
  const entry = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
  if (entry && entry.origin === 'registro') {
    await catalog.deleteOne({ _id: entry._id })
  }
}

/**
 * GET /api/operations/stats?companyId=xxx
 * Devuelve el conteo de operaciones agrupado por tipo.
 * Usa un aggregation real sobre TODAS las operaciones de la empresa (sin límite).
 * Response: { byType: { [operationType]: count }, total: number, productos: number }
 */
operationsRouter.get('/stats', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const col = getOperationsCollection()
    const pipeline = [
      { $match: { companyId } },
      {
        $facet: {
          byType: [
            { $group: { _id: '$operationType', count: { $sum: 1 } } },
          ],
          total: [{ $count: 'count' }],
          uniqueProducts: [
            { $unwind: { path: '$lineaBlanca', preserveNullAndEmptyArrays: false } },
            { $group: { _id: { $toLower: '$lineaBlanca.productCode' } } },
            { $count: 'count' },
          ],
        },
      },
    ]
    const [result] = await col.aggregate(pipeline).toArray() as Array<{
      byType: Array<{ _id: string; count: number }>
      total: Array<{ count: number }>
      uniqueProducts: Array<{ count: number }>
    }>
    const catalog = getProductsCatalogCollection()
    const catalogCount = await catalog.countDocuments({ companyId, origin: 'catalog' })
    res.json({
      byType: Object.fromEntries((result?.byType ?? []).map((b) => [b._id, b.count])),
      total: result?.total?.[0]?.count ?? 0,
      productos: (result?.uniqueProducts?.[0]?.count ?? 0) + catalogCount,
    })
  } catch (err) {
    console.error('[operations] Error al obtener stats:', err)
    res.status(500).json({ message: 'Error al obtener estadísticas.' })
  }
})

/**
 * POST /api/operations
 * Crea una nueva operación (Productos Entrantes o Productos Salientes).
 */
operationsRouter.post('/', async (req, res) => {
  const { operationType, operatorName, vehiclePlate, companyId, locationId, isTransfer, origin, destination } = req.body ?? {}

  if (!operationType || typeof operationType !== 'string' || !operationType.trim()) {
    res.status(400).json({ message: 'operationType es requerido.' })
    return
  }

  // Acepta los tipos por defecto o cualquier tipo personalizado configurado por
  // la empresa en company_settings.operationTypes.
  if (!VALID_TYPES.includes(operationType as OperationType)) {
    let allowed = false
    if (companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId })
      const custom = Array.isArray(settings?.operationTypes) ? (settings!.operationTypes as Array<{ id?: string }>) : []
      allowed = custom.some((t) => t?.id === operationType)
    }
    if (!allowed) {
      res.status(400).json({ message: 'operationType no es válido. Configúralo en Configuración → Tipos de operación.' })
      return
    }
  }

  if (!operatorName?.trim()) {
    res.status(400).json({ message: 'operatorName es requerido.' })
    return
  }

  try {
    const trackingCode = await generateTrackingCode()
    const now = new Date().toISOString()

    // Resuelve ubicaciones (origen/destino) si la función está habilitada. El
    // destino aloja los productos; el origen es opcional (traspaso). Se conserva
    // además locationId/locationName legacy desde el destino de tipo lugar.
    const cid = companyId?.trim()
    const { enabled: locEnabled, places } = await getCompanyLocationCtx(cid)
    let destRef: LocationRef | null = null
    let originRef: LocationRef | null = null
    let transfer = false
    if (locEnabled) {
      transfer = isTransfer === true
      // Compat: si llega `locationId` (API vieja) se trata como destino de tipo lugar.
      const destInput = destination ?? (typeof locationId === 'string' && locationId.trim()
        ? { type: 'lugar', id: locationId.trim() }
        : undefined)
      destRef = destInput ? toLocationRef(destInput, places) : null
      originRef = origin ? toLocationRef(origin, places) : null
      // Un traspaso requiere destino (Req 2.4).
      if (transfer && !destRef) {
        res.status(400).json({ message: 'El traspaso requiere un destino (punto final).' })
        return
      }
    }

    const operation = {
      trackingCode,
      operationType,
      operatorName: operatorName.trim(),
      vehiclePlate: vehiclePlate?.trim() || undefined,
      isTransfer: transfer || undefined,
      origin: originRef ?? undefined,
      destination: destRef ?? undefined,
      // Legacy: refleja el destino de tipo lugar para Historial/Wizard/Detalle.
      locationId: destRef?.type === 'lugar' ? destRef.id : undefined,
      locationName: destRef?.name,
      companyId: cid ?? undefined,
      photos: [],
      lineaBlanca: [],
      status: 'EN_PROCESO',
      createdAt: now,
      updatedAt: now,
    }

    const col = getOperationsCollection()
    await col.insertOne(operation)

    void logActivity(
      operation.companyId,
      'operacion_creada',
      `Operación ${trackingCode} creada por ${operation.operatorName}`,
      { trackingCode, operationType, operatorName: operation.operatorName },
    )

    res.status(201).json({
      ...operation,
      steps: getStepsForType(operationType as OperationType),
      totalSteps: getStepsForType(operationType as OperationType).length,
      lineaBlancaSteps: [...LINEA_BLANCA_STEPS],
    })
  } catch (err) {
    console.error('[operations] Error al crear:', err)
    res.status(500).json({ message: 'Error interno al crear la operación.' })
  }
})

/**
 * GET /api/operations
 * Lista operaciones con filtros opcionales.
 */
operationsRouter.get('/', async (req, res) => {
  const { operationType, status, date, operatorName, vehiclePlate, companyId, productName, limit = '50', page = '1' } = req.query as Record<string, string>

  const filter: Record<string, unknown> = {}
  if (companyId) {
    filter.companyId = companyId
  } else {
    // Sin companyId → no devolver nada (previene ver operaciones de otras empresas)
    filter.companyId = { $exists: false }
  }
  if (operationType) filter.operationType = operationType
  if (status) filter.status = status
  if (operatorName) filter.operatorName = { $regex: operatorName, $options: 'i' }
  if (vehiclePlate) filter.vehiclePlate = { $regex: vehiclePlate, $options: 'i' }
  if (productName) {
    // Buscar por nombre/código de producto dentro de lineaBlanca
    filter['lineaBlanca.productCode'] = { $regex: productName, $options: 'i' }
  }
  if (date) {
    filter.createdAt = {
      $gte: `${date}T00:00:00.000Z`,
      $lte: `${date}T23:59:59.999Z`,
    }
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1)
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50))
  const skip = (pageNum - 1) * limitNum

  try {
    const col = getOperationsCollection()
    const [operations, total] = await Promise.all([
      col.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray(),
      col.countDocuments(filter),
    ])

    // Re-firma las URLs de R2 (caducan) antes de devolverlas para que las
    // miniaturas del historial no aparezcan rotas en operaciones antiguas.
    const freshOperations = await Promise.all(
      operations.map((op) => withFreshPhotoUrls(op as Record<string, unknown>)),
    )

    res.json({
      operations: freshOperations,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    })
  } catch (err) {
    console.error('[operations] Error al listar:', err)
    res.status(500).json({ message: 'Error al obtener operaciones.' })
  }
})

/**
 * GET /api/operations/search-for-link
 * Busca operaciones disponibles para vincular un producto (excluye la operación actual).
 * Query: ?exclude=TRACKING_CODE&companyId=XXX
 */
operationsRouter.get('/search-for-link', async (req, res) => {
  const { exclude, companyId, q } = req.query as Record<string, string>

  try {
    const col = getOperationsCollection()
    const filter: Record<string, unknown> = {}
    if (exclude) filter.trackingCode = { $ne: exclude }
    if (companyId) filter.companyId = companyId
    if (q) {
      filter.$or = [
        { trackingCode: { $regex: q, $options: 'i' } },
        { operatorName: { $regex: q, $options: 'i' } },
        { vehiclePlate: { $regex: q, $options: 'i' } },
      ]
    }

    const operations = await col.find(filter).sort({ createdAt: -1 }).limit(10).toArray()

    // Stats globales de la empresa: conteos reales de operaciones y productos.
    const statsFilter: Record<string, unknown> = {}
    if (companyId) statsFilter.companyId = companyId

    const statsPipeline = [
      { $match: statsFilter },
      {
        $facet: {
          byType: [
            { $group: { _id: '$operationType', count: { $sum: 1 } } },
          ],
          uniqueProducts: [
            { $unwind: { path: '$lineaBlanca', preserveNullAndEmptyArrays: false } },
            { $group: { _id: { $toLower: '$lineaBlanca.productCode' } } },
            { $count: 'count' },
          ],
        },
      },
    ]

    const [faceted] = await col.aggregate(statsPipeline).toArray() as Array<{
      byType: Array<{ _id: string; count: number }>
      uniqueProducts: Array<{ count: number }>
    }>

    // Productos del catálogo maestro (origin: 'catalog') que no provienen de
    // operaciones y por tanto no están en el conteo uniqueProducts.
    const catalog = getProductsCatalogCollection()
    const catalogCount = await catalog.countDocuments({ ...statsFilter, origin: 'catalog' })

    const stats = {
      entrantes: faceted?.byType?.find((b) => b._id === 'PRODUCTOS_ENTRANTES')?.count ?? 0,
      salientes: faceted?.byType?.find((b) => b._id === 'PRODUCTOS_SALIENTES')?.count ?? 0,
      productos: (faceted?.uniqueProducts?.[0]?.count ?? 0) + catalogCount,
      // Conteo por cada tipo (incluye tipos personalizados): { [operationType]: count }
      byType: Object.fromEntries((faceted?.byType ?? []).map((b) => [b._id, b.count])) as Record<string, number>,
    }

    res.json({ operations, stats })
  } catch (err) {
    console.error('[operations] Error al buscar para vincular:', err)
    res.status(500).json({ message: 'Error al buscar operaciones.' })
  }
})

/**
 * GET /api/operations/search-products
 * Busca productos existentes (por código o descripción) en las operaciones de la empresa.
 * Query: ?q=texto&companyId=XXX
 * Devuelve coincidencias con la operación donde están.
 */
operationsRouter.get('/search-products', async (req, res) => {
  const { q, companyId } = req.query as Record<string, string>
  const query = (q ?? '').trim()
  const lower = query.toLowerCase()
  // Sin query: devuelve la lista de productos recientes (para autocompletado)
  const listAll = query.length === 0

  try {
    const col = getOperationsCollection()
    const filter: Record<string, unknown> = {}
    if (companyId) filter.companyId = companyId

    // Trae operaciones recientes de la empresa y filtra productos en memoria
    const operations = await col.find(filter).sort({ createdAt: -1 }).limit(200).toArray()

    const results: Array<{
      productCode: string
      descripcion?: string
      photosCount: number
      trackingCode: string
      operationType: string
      createdAt?: string
    }> = []
    const seen = new Set<string>()

    for (const op of operations) {
      const products = (op.lineaBlanca as LineaBlancaProduct[]) ?? []
      for (const p of products) {
        const code = (p.productCode ?? '').toLowerCase()
        const desc = (p.labelData?.descripcion ?? '').toLowerCase()
        const matches = listAll || code.includes(lower) || desc.includes(lower)
        if (!matches) continue
        // Evita duplicar el mismo código en el autocompletado
        if (listAll && seen.has(code)) continue
        seen.add(code)
        results.push({
          productCode: p.productCode,
          descripcion: p.labelData?.descripcion,
          photosCount: p.photos?.length ?? 0,
          trackingCode: op.trackingCode as string,
          operationType: op.operationType as string,
          createdAt: p.createdAt as string | undefined,
        })
      }
      if (results.length >= (listAll ? 100 : 20)) break
    }

    res.json({ products: results.slice(0, listAll ? 100 : 20) })
  } catch (err) {
    console.error('[operations] Error al buscar productos:', err)
    res.status(500).json({ message: 'Error al buscar productos.' })
  }
})

/**
 * POST /api/operations/products-catalog
 * Registra un producto en el catálogo maestro (independiente de cualquier registro).
 * Body: { companyId?, productCode, descripcion? }
 */
operationsRouter.post('/products-catalog', async (req, res) => {
  const { companyId, productCode, descripcion } = req.body ?? {}
  const code = (productCode ?? '').trim()
  if (!code) { res.status(400).json({ message: 'productCode es requerido.' }); return }

  try {
    // Verifica que no exista ya (en catálogo o en operaciones de la empresa)
    const catalog = getProductsCatalogCollection()
    const existingCatalog = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
    if (existingCatalog) { res.status(409).json({ message: `El producto "${code}" ya existe en el catálogo.` }); return }

    const ops = getOperationsCollection()
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const opFilter: Record<string, unknown> = { 'lineaBlanca.productCode': { $regex: `^${escaped}$`, $options: 'i' } }
    if (companyId) opFilter.companyId = companyId
    const inOps = await ops.findOne(opFilter)
    if (inOps) { res.status(409).json({ message: `El código "${code}" ya existe en la operación ${inOps.trackingCode}.` }); return }

    await upsertCatalogProduct(companyId, code, descripcion, 'catalog')
    res.status(201).json({ message: `Producto "${code}" registrado en el catálogo.` })
  } catch (err) {
    console.error('[operations] Error al registrar producto en catálogo:', err)
    res.status(500).json({ message: 'Error al registrar el producto.' })
  }
})

/**
 * DELETE /api/operations/products-catalog/:productCode
 * Elimina un producto del catálogo maestro (solo si no está en ningún registro).
 * Query: ?companyId=XXX
 */
operationsRouter.delete('/products-catalog/:productCode', async (req, res) => {
  const { productCode } = req.params
  const { companyId } = req.query as Record<string, string>
  const code = productCode.trim()
  try {
    const ops = getOperationsCollection()
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const opFilter: Record<string, unknown> = { 'lineaBlanca.productCode': { $regex: `^${escaped}$`, $options: 'i' } }
    if (companyId) opFilter.companyId = companyId
    const inOps = await ops.findOne(opFilter)
    if (inOps) { res.status(409).json({ message: `No se puede eliminar: el producto está en la operación ${inOps.trackingCode}.` }); return }

    const catalog = getProductsCatalogCollection()
    await catalog.deleteOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
    res.json({ message: `Producto "${code}" eliminado del catálogo.` })
  } catch (err) {
    console.error('[operations] Error al eliminar del catálogo:', err)
    res.status(500).json({ message: 'Error al eliminar el producto del catálogo.' })
  }
})

/**
 * PATCH /api/operations/products-catalog/:productCode
 * Edita un producto del catálogo: nuevo código y/o descripción.
 * Propaga los cambios a TODAS las operaciones donde esté asignado.
 * Body: { companyId?, newProductCode?, descripcion? }
 */
operationsRouter.patch('/products-catalog/:productCode', async (req, res) => {
  const { productCode } = req.params
  const { companyId, newProductCode, descripcion } = req.body ?? {}
  const oldCode = productCode.trim()
  const newCode = (newProductCode ?? oldCode).trim()

  try {
    const ops = getOperationsCollection()
    const catalog = getProductsCatalogCollection()

    // Si cambia el código, verifica unicidad global (excepto el mismo producto)
    if (newCode.toLowerCase() !== oldCode.toLowerCase()) {
      const escapedNew = newCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const dupFilter: Record<string, unknown> = { 'lineaBlanca.productCode': { $regex: `^${escapedNew}$`, $options: 'i' } }
      if (companyId) dupFilter.companyId = companyId
      const dupOp = await ops.findOne(dupFilter)
      if (dupOp) { res.status(409).json({ message: `El código "${newCode}" ya existe en la operación ${dupOp.trackingCode}.` }); return }
      const dupCat = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: newCode.toLowerCase() })
      if (dupCat) { res.status(409).json({ message: `El código "${newCode}" ya existe en el catálogo.` }); return }
    }

    // Actualiza en todas las operaciones donde esté el producto
    const escapedOld = oldCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const opFilter: Record<string, unknown> = { 'lineaBlanca.productCode': { $regex: `^${escapedOld}$`, $options: 'i' } }
    if (companyId) opFilter.companyId = companyId
    const affectedOps = await ops.find(opFilter).toArray()
    for (const op of affectedOps) {
      const products = (op.lineaBlanca as LineaBlancaProduct[]) ?? []
      const idx = products.findIndex((p) => (p.productCode ?? '').toLowerCase() === oldCode.toLowerCase())
      if (idx === -1) continue
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
      set[`lineaBlanca.${idx}.productCode`] = newCode
      if (descripcion !== undefined) set[`lineaBlanca.${idx}.labelData.descripcion`] = descripcion.trim() || undefined
      await ops.updateOne({ trackingCode: op.trackingCode }, { $set: set })
    }

    // Actualiza el catálogo maestro
    const entry = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: oldCode.toLowerCase() })
    if (entry) {
      const set: Record<string, unknown> = { productCode: newCode, productCodeLower: newCode.toLowerCase() }
      if (descripcion !== undefined) set.descripcion = descripcion.trim() || undefined
      await catalog.updateOne({ _id: entry._id }, { $set: set })
    } else {
      // No estaba en catálogo (producto antiguo solo en operaciones): lo crea
      await upsertCatalogProduct(companyId, newCode, descripcion, 'registro')
    }

    res.json({ message: `Producto actualizado.`, productCode: newCode })
  } catch (err) {
    console.error('[operations] Error al editar producto del catálogo:', err)
    res.status(500).json({ message: 'Error al editar el producto.' })
  }
})

/**
 * POST /api/operations/products-catalog/:productCode/photo
 * Sube una foto directamente al producto del catálogo (sin necesidad de un registro).
 * Body: { companyId?, base64Image, mimeType?, comment? }
 */
operationsRouter.post('/products-catalog/:productCode/photo', async (req, res) => {
  const { productCode } = req.params
  const { companyId, base64Image, mimeType, comment } = req.body ?? {}
  const code = productCode.trim()
  if (!base64Image) { res.status(400).json({ message: 'base64Image es requerido.' }); return }

  try {
    const catalog = getProductsCatalogCollection()
    let entry = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
    // Si no existe en el catálogo, lo crea (origen catalog)
    if (!entry) {
      await upsertCatalogProduct(companyId, code, undefined, 'catalog')
      entry = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
      if (!entry) { res.status(500).json({ message: 'No se pudo crear el producto en el catálogo.' }); return }
    }

    const cleanCode = code.replace(/[^a-zA-Z0-9]/g, '_')
    const existing = (entry.photos as Array<unknown> | undefined)?.length ?? 0
    const fileName = `CATALOGO_${cleanCode}_${existing + 1}.jpg`

    const driveResult = await uploadToDrive({
      base64Image,
      fileName,
      mimeType: mimeType || 'image/jpeg',
      subfolderName: 'CATALOGO_PRODUCTOS',
      subSubfolderName: code,
      companyId: companyId as string | undefined,
    })

    const fileId = driveResult.fileId ?? ''
    const driveUrl = driveResult.driveUrl ?? ''
    if (driveResult.status === 'error') {
      if ((driveResult.message ?? '').includes('no configurado')) { res.status(502).json({ message: 'Almacenamiento no configurado en el servidor (R2 o GitHub).' }); return }
      // Fallo transitorio: no persistir marcador roto; pedir reintento (503).
      console.error(`[catalogo] Subida de foto fallida: ${driveResult.message}`)
      res.status(503).json({ message: 'No se pudo subir la imagen al almacenamiento. Reintenta en unos segundos.', detail: driveResult.message }); return
    }

    const photo = { fileId, driveUrl, comment: comment?.trim() || undefined, timestamp: new Date().toISOString() }
    await catalog.updateOne({ _id: entry._id }, { $push: { photos: photo } } as unknown as Record<string, unknown>)

    res.json({ message: 'Foto agregada al producto.', photo })
  } catch (err) {
    console.error('[operations] Error al subir foto al catálogo:', err)
    res.status(500).json({ message: 'Error al subir la foto.' })
  }
})

/**
 * DELETE /api/operations/products-catalog/:productCode/photo/:photoIndex
 * Elimina una foto propia del producto del catálogo.
 * Query: ?companyId=XXX
 */
operationsRouter.delete('/products-catalog/:productCode/photo/:photoIndex', async (req, res) => {
  const { productCode, photoIndex } = req.params
  const { companyId } = req.query as Record<string, string>
  const idx = Number(photoIndex)
  const code = productCode.trim()

  try {
    const catalog = getProductsCatalogCollection()
    const entry = await catalog.findOne({ companyId: companyId ?? null, productCodeLower: code.toLowerCase() })
    if (!entry) { res.status(404).json({ message: 'Producto no encontrado en el catálogo.' }); return }

    const photos = (entry.photos as Array<{ fileId: string }> | undefined) ?? []
    if (idx < 0 || idx >= photos.length) { res.status(400).json({ message: 'Índice de foto inválido.' }); return }

    photos.splice(idx, 1)
    await catalog.updateOne({ _id: entry._id }, { $set: { photos } })
    res.json({ message: 'Foto eliminada.', remaining: photos.length })
  } catch (err) {
    console.error('[operations] Error al eliminar foto del catálogo:', err)
    res.status(500).json({ message: 'Error al eliminar la foto.' })
  }
})

/**
 * GET /api/operations/products-catalog
 * Catálogo de productos: combina el catálogo maestro (incluye productos sin registro)
 * con las operaciones (registros) donde cada producto está asignado.
 * Query: ?companyId=XXX&q=texto
 */
operationsRouter.get('/products-catalog', async (req, res) => {
  const { companyId, q } = req.query as Record<string, string>
  const query = (q ?? '').trim().toLowerCase()

  try {
    const col = getOperationsCollection()
    const filter: Record<string, unknown> = {}
    if (companyId) filter.companyId = companyId

    const operations = await col.find(filter).sort({ createdAt: -1 }).toArray()

    // Agrupa por código de producto (case-insensitive)
    const map = new Map<string, {
      productCode: string
      descripcion?: string
      totalPhotos: number
      catalogPhotos: Array<{ fileId: string; comment?: string }>
      assignments: Array<{
        trackingCode: string
        operationType: string
        operatorName?: string
        vehiclePlate?: string
        status: string
        photosCount: number
        createdAt?: string
        photos: Array<{ fileId: string; comment?: string }>
      }>
    }>()

    for (const op of operations) {
      const products = (op.lineaBlanca as LineaBlancaProduct[]) ?? []
      for (const p of products) {
        if (!p?.productCode) continue // ignora productos sin código (datos antiguos)
        const key = p.productCode.toLowerCase()
        if (query && !key.includes(query) && !(p.labelData?.descripcion ?? '').toLowerCase().includes(query)) continue
        let entry = map.get(key)
        if (!entry) {
          entry = { productCode: p.productCode, descripcion: p.labelData?.descripcion, totalPhotos: 0, catalogPhotos: [], assignments: [] }
          map.set(key, entry)
        }
        if (!entry.descripcion && p.labelData?.descripcion) entry.descripcion = p.labelData.descripcion
        entry.totalPhotos += p.photos?.length ?? 0
        entry.assignments.push({
          trackingCode: op.trackingCode as string,
          operationType: op.operationType as string,
          operatorName: op.operatorName as string | undefined,
          vehiclePlate: op.vehiclePlate as string | undefined,
          status: op.status as string,
          photosCount: p.photos?.length ?? 0,
          createdAt: p.createdAt as string | undefined,
          photos: (p.photos ?? []).map((ph) => ({ fileId: ph.fileId, comment: ph.comment })),
        })
      }
    }

    // Incluye productos del catálogo maestro que aún no están en ningún registro
    const catalog = getProductsCatalogCollection()
    const catalogFilter: Record<string, unknown> = {}
    if (companyId) catalogFilter.companyId = companyId
    const catalogItems = await catalog.find(catalogFilter).toArray()
    for (const item of catalogItems) {
      if (!item?.productCode) continue
      const key = (item.productCode as string).toLowerCase()
      const desc = (item.descripcion as string | undefined) ?? ''
      if (query && !key.includes(query) && !desc.toLowerCase().includes(query)) continue
      const catalogPhotos = ((item.photos as Array<{ fileId: string; comment?: string }> | undefined) ?? [])
        .map((ph) => ({ fileId: ph.fileId, comment: ph.comment }))
      let entry = map.get(key)
      if (!entry) {
        entry = {
          productCode: item.productCode as string,
          descripcion: item.descripcion as string | undefined,
          totalPhotos: 0,
          catalogPhotos: [],
          assignments: [],
        }
        map.set(key, entry)
      }
      entry.catalogPhotos = catalogPhotos
      entry.totalPhotos += catalogPhotos.length
    }

    const products = Array.from(map.values())
      .map((e) => ({ ...e, registrosCount: e.assignments.length }))
      .sort((a, b) => a.productCode.localeCompare(b.productCode))

    // Enriquece cada producto con su ubicación actual (último movimiento), con
    // una sola agregación por empresa agrupada por productCodeLower.
    if (companyId) {
      try {
        const movCol = getMovementsCollection()
        const rows = await movCol.aggregate([
          { $match: { companyId } },
          { $sort: { at: -1 } },
          { $group: { _id: '$productCodeLower', to: { $first: '$to' } } },
        ]).toArray()
        const currentByCode = new Map<string, LocationRef>()
        for (const r of rows) currentByCode.set(r._id as string, r.to as LocationRef)
        for (const p of products) {
          ;(p as Record<string, unknown>).currentLocation = currentByCode.get(p.productCode.toLowerCase()) ?? null
        }
      } catch (err) {
        console.error('[operations] Error al calcular ubicación actual:', err)
      }
    }

    res.json({ products, total: products.length })
  } catch (err) {
    console.error('[operations] Error en catálogo de productos:', err)
    res.status(500).json({ message: 'Error al obtener el catálogo de productos.' })
  }
})

/**
 * GET /api/operations/products/:productCode/movements?companyId=xxx
 * Devuelve el recorrido (historial de movimientos) de un producto, ordenado por
 * fecha ascendente (del más antiguo al más reciente).
 */
operationsRouter.get('/products/:productCode/movements', async (req, res) => {
  const { productCode } = req.params
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const movCol = getMovementsCollection()
    const rows = await movCol
      .find({ companyId, productCodeLower: productCode.trim().toLowerCase() })
      .sort({ at: 1 })
      .toArray()
    const movements = rows.map((m) => ({
      from: m.from ?? null,
      to: m.to,
      trackingCode: m.trackingCode,
      inferred: Boolean(m.inferred),
      at: m.at,
    }))
    res.json({ movements })
  } catch (err) {
    console.error('[operations] Error al leer movimientos:', err)
    res.status(500).json({ message: 'Error al leer el recorrido del producto.' })
  }
})

/**
 * GET /api/operations/:trackingCode
 * Obtiene una operación por su código de tracking.
 */
operationsRouter.get('/:trackingCode', async (req, res) => {
  const { trackingCode } = req.params

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })

    if (!operation) {
      res.status(404).json({ message: 'Operación no encontrada.' })
      return
    }

    const steps = getStepsForType(operation.operationType as OperationType)
    const fresh = await withFreshPhotoUrls(operation as Record<string, unknown>)
    res.json({
      ...fresh,
      steps,
      totalSteps: steps.length,
      lineaBlancaSteps: [...LINEA_BLANCA_STEPS],
    })
  } catch (err) {
    console.error('[operations] Error al obtener:', err)
    res.status(500).json({ message: 'Error al obtener la operación.' })
  }
})

/**
 * POST /api/operations/:trackingCode/linea-blanca
 * Agrega un nuevo producto de Línea Blanca a la operación.
 * Body: { productCode }
 */
operationsRouter.post('/:trackingCode/linea-blanca', async (req, res) => {
  const { trackingCode } = req.params
  const { productCode, labelData, isLineaBlanca } = req.body ?? {}

  if (!productCode?.trim()) {
    res.status(400).json({ message: 'productCode es requerido.' })
    return
  }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })

    if (!operation) {
      res.status(404).json({ message: 'Operación no encontrada.' })
      return
    }

    if (operation.status === 'COMPLETADO') {
      res.status(409).json({ message: 'La operación ya está completada.' })
      return
    }

    const code = productCode.trim()

    // Verifica que no exista ya un producto con ese código en ESTA operación
    const existing = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    if (existing.some((p) => p.productCode.toLowerCase() === code.toLowerCase())) {
      res.status(409).json({ message: `El producto "${code}" ya está registrado en esta operación.` })
      return
    }

    const companyId = operation.companyId as string | undefined
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const dupFilter: Record<string, unknown> = {
      trackingCode: { $ne: trackingCode },
      'lineaBlanca.productCode': { $regex: `^${escaped}$`, $options: 'i' },
    }
    if (companyId) dupFilter.companyId = companyId
    const duplicate = await col.findOne(dupFilter)

    // Si el producto ya existe en OTRA operación, lo VINCULAMOS en vez de rechazar
    if (duplicate) {
      const sourceTrackingCode = duplicate.trackingCode as string
      const sourceProducts = (duplicate.lineaBlanca as LineaBlancaProduct[]) ?? []
      const sourceIdx = sourceProducts.findIndex((p) => p.productCode.toLowerCase() === code.toLowerCase())

      if (sourceIdx === -1) {
        res.status(500).json({ message: 'Error al ubicar el producto en la operación origen.' })
        return
      }

      const sourceProduct = sourceProducts[sourceIdx]
      const sourceLinkedTo = sourceProduct.linkedTo ?? []
      const newSourceLinkedTo = [...new Set([...sourceLinkedTo, trackingCode])]

      const linkedProduct: LineaBlancaProduct = {
        productCode: sourceProduct.productCode,
        labelData: labelData ? { ...(sourceProduct.labelData ?? {}), ...labelData } : sourceProduct.labelData,
        isLineaBlanca: Boolean(isLineaBlanca) || sourceProduct.isLineaBlanca,
        linkedTo: [sourceTrackingCode],
        photos: [...sourceProduct.photos],
        status: 'EN_PROCESO',
        createdAt: new Date().toISOString(),
      }

      await col.updateOne(
        { trackingCode },
        {
          $push: { lineaBlanca: linkedProduct },
          $set: { updatedAt: new Date().toISOString() },
        } as unknown as Record<string, unknown>,
      )

      await col.updateOne(
        { trackingCode: sourceTrackingCode, 'lineaBlanca.productCode': sourceProduct.productCode },
        { $set: { [`lineaBlanca.${sourceIdx}.linkedTo`]: newSourceLinkedTo, updatedAt: new Date().toISOString() } },
      )

      await upsertCatalogProduct(companyId, code, (labelData as { descripcion?: string } | undefined)?.descripcion ?? sourceProduct.labelData?.descripcion, 'registro')

      // Registra el movimiento del producto hacia el destino de esta operación
      // (si tiene). El origen explícito es el de la operación, si existe.
      if (operation.destination) {
        await recordMovement({
          companyId: companyId as string,
          productCode: code,
          destination: operation.destination as LocationRef,
          originExplicit: (operation.origin as LocationRef | undefined) ?? null,
          trackingCode,
        })
      }

      res.status(201).json({
        message: `Producto "${code}" vinculado desde la operación ${sourceTrackingCode}. Las fotos se sincronizarán automáticamente.`,
        product: linkedProduct,
        steps: [...LINEA_BLANCA_STEPS],
        linkedFrom: sourceTrackingCode,
      })
      return
    }

    const newProduct: LineaBlancaProduct = {
      productCode: productCode.trim(),
      ...(labelData ? { labelData } : {}),
      isLineaBlanca: Boolean(isLineaBlanca),
      photos: [],
      status: 'EN_PROCESO',
      createdAt: new Date().toISOString(),
    }

    await col.updateOne(
      { trackingCode },
      {
        $push: { lineaBlanca: newProduct },
        $set: { updatedAt: new Date().toISOString() },
      } as unknown as Record<string, unknown>,
    )

    await upsertCatalogProduct(companyId, code, (labelData as { descripcion?: string } | undefined)?.descripcion, 'registro')

    // Registra el movimiento del producto hacia el destino de esta operación.
    if (operation.destination) {
      await recordMovement({
        companyId: companyId as string,
        productCode: code,
        destination: operation.destination as LocationRef,
        originExplicit: (operation.origin as LocationRef | undefined) ?? null,
        trackingCode,
      })
    }

    res.status(201).json({
      message: `Producto ${productCode.trim()} agregado.`,
      product: newProduct,
      steps: [...LINEA_BLANCA_STEPS],
    })
  } catch (err) {
    console.error('[operations] Error al agregar línea blanca:', err)
    res.status(500).json({ message: 'Error al agregar producto.' })
  }
})

/**
 * POST /api/operations/:trackingCode/linea-blanca/:productCode/photo
 * Sube una foto para un producto de línea blanca específico.
 * Body: { stepIndex, base64Image, mimeType? }
 */
operationsRouter.post('/:trackingCode/linea-blanca/:productCode/photo', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { stepIndex, base64Image, mimeType, comment, clientTimestamp, groupId, clientKey } = req.body ?? {}

  if (stepIndex === undefined || stepIndex === null) {
    res.status(400).json({ message: 'stepIndex es requerido.' })
    return
  }
  if (!base64Image) {
    res.status(400).json({ message: 'base64Image es requerido.' })
    return
  }

  const idx = Number(stepIndex)
  if (idx < 0) {
    res.status(400).json({ message: 'stepIndex debe ser >= 0.' })
    return
  }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })

    if (!operation) {
      res.status(404).json({ message: 'Operación no encontrada.' })
      return
    }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)

    if (productIdx === -1) {
      res.status(404).json({ message: `Producto "${productCode}" no encontrado en esta operación.` })
      return
    }

    const product = products[productIdx]

    // Dedupe idempotente: si este clientKey ya está en el producto, no re-subir.
    if (clientKey) {
      const existing = (product.photos ?? []).find((p) => p.clientKey === clientKey)
      if (existing) {
        res.json({ message: 'Foto ya registrada (idempotente).', photo: existing, duplicate: true, progress: { current: product.photos?.length ?? 0, total: 0 } })
        return
      }
    }
    // Producto completado manualmente por el usuario — puede seguir agregando fotos
    // (se reabre automáticamente al agregar más)
    if (product.status === 'COMPLETADO') {
      products[productIdx].status = 'EN_PROCESO'
      await col.updateOne({ trackingCode }, { $set: { [`lineaBlanca.${productIdx}.status`]: 'EN_PROCESO' } })
    }

    // Sube a Drive — subcarpeta del producto dentro de la operación
    const { uploadToDrive } = await import('../lib/drive-upload.js')
    const vehicleFolder = operation.vehiclePlate
      ? `${operation.operationType}_${operation.vehiclePlate}`
      : `${operation.operationType}_${trackingCode}`
    const stepName = LINEA_BLANCA_STEPS[idx] ?? `Foto_${idx + 1}`
    const safeStepName = stepName.replace(/[^a-zA-Z0-9]/g, '_')
    const fileName = `${trackingCode}_LB_${productCode}_foto${idx + 1}_${safeStepName}.jpg`

    const driveResult = await uploadToDrive({
      base64Image,
      fileName,
      mimeType: mimeType || 'image/jpeg',
      subfolderName: vehicleFolder,
      subSubfolderName: productCode,
      companyId: operation.companyId as string | undefined,
    })

    const fileId = driveResult.fileId ?? ''
    const driveUrl = driveResult.driveUrl ?? ''

    if (driveResult.status === 'error') {
      const errorMsg = driveResult.message ?? ''
      if (errorMsg.includes('no configurado')) {
        res.status(502).json({ message: 'Error al subir la imagen: almacenamiento no configurado en el servidor.', detail: errorMsg })
        return
      }
      // Fallo transitorio de subida: no persistir un marcador roto
      // ('pending-verification'). Respondemos 503 para que el cliente conserve
      // la foto en cache y la reintente (tiene backoff). Antes se registraba
      // igualmente y la foto quedaba como cuadro gris permanente.
      console.error(`[linea-blanca] Subida de foto fallida: ${errorMsg}`)
      res.status(503).json({ message: 'No se pudo subir la imagen al almacenamiento. Reintenta en unos segundos.', detail: errorMsg })
      return
    }

    const photoRecord: PhotoRecord = {
      stepIndex: idx,
      stepName,
      driveUrl,
      fileId,
      productCode,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
      ...(groupId ? { groupId: String(groupId) } : {}),
      ...(clientKey ? { clientKey: String(clientKey) } : {}),
      photoType: 'producto',
      timestamp: normalizeClientTimestamp(clientTimestamp),
    }

    // Siempre agregar (sin reemplazar) — permite fotos ilimitadas
    await col.updateOne(
      { trackingCode, 'lineaBlanca.productCode': productCode },
      {
        $push: { [`lineaBlanca.${productIdx}.photos`]: photoRecord },
        $set: { updatedAt: new Date().toISOString() },
      } as unknown as Record<string, unknown>,
    )

    // No auto-completar — el usuario decide cuándo terminar el producto
    const updatedOp = await col.findOne({ trackingCode })
    const updatedProduct = (updatedOp?.lineaBlanca as LineaBlancaProduct[])?.[productIdx]

    // ── Sincronizar foto a operaciones vinculadas ──
    // Re-leer linkedTo del producto actualizado en la DB (puede haber cambiado)
    const currentLinkedTo = updatedProduct?.linkedTo ?? []
    console.log(`[linea-blanca] Producto ${productCode} linkedTo:`, currentLinkedTo)
    if (currentLinkedTo.length > 0) {
      for (const linkedTrackingCode of currentLinkedTo) {
        try {
          const linkedOp = await col.findOne({ trackingCode: linkedTrackingCode })
          if (!linkedOp) { console.warn(`[sync] Operación ${linkedTrackingCode} no encontrada`); continue }
          const linkedProducts = (linkedOp.lineaBlanca as LineaBlancaProduct[]) ?? []
          const linkedProductIdx = linkedProducts.findIndex((p) => p.productCode === productCode)
          if (linkedProductIdx === -1) { console.warn(`[sync] Producto ${productCode} no encontrado en ${linkedTrackingCode}`); continue }

          // Verificar que la foto no exista ya (por timestamp) para evitar duplicados
          const existingPhotos = linkedProducts[linkedProductIdx].photos ?? []
          const alreadySynced = existingPhotos.some((p) => p.timestamp === photoRecord.timestamp)
          if (alreadySynced) { console.log(`[sync] Foto ya existe en ${linkedTrackingCode}`); continue }

          await col.updateOne(
            { trackingCode: linkedTrackingCode, 'lineaBlanca.productCode': productCode },
            {
              $push: { [`lineaBlanca.${linkedProductIdx}.photos`]: photoRecord },
              $set: { updatedAt: new Date().toISOString() },
            } as unknown as Record<string, unknown>,
          )
          console.log(`[sync] ✓ Foto sincronizada a ${linkedTrackingCode}`)
        } catch (syncErr) {
          console.warn(`[linea-blanca] Error al sincronizar foto a ${linkedTrackingCode}:`, syncErr)
        }
      }
    }

    res.json({
      message: 'Foto de producto registrada.',
      photo: photoRecord,
      progress: {
        current: updatedProduct?.photos.length ?? 0,
        total: 0, // Sin límite fijo
      },
      synced: currentLinkedTo.length,
    })
  } catch (err) {
    console.error('[linea-blanca] Error:', err)
    res.status(500).json({ message: 'Error al procesar foto de línea blanca.' })
  }
})

/**
 * POST /api/operations/:trackingCode/linea-blanca/:productCode/photo-batch
 * Sube VARIAS fotos de un producto en una sola tanda, con UN solo $push ($each)
 * para evitar la condición de carrera que duplicaba/perdía fotos al subirlas en
 * paralelo. Deduplica por `clientKey` (idempotente ante reintentos).
 * Body: { groupId?, comment?, clientTimestamp?, mimeType?, photos: [{ base64Image, comment?, clientTimestamp?, clientKey? }] }
 */
operationsRouter.post('/:trackingCode/linea-blanca/:productCode/photo-batch', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { groupId, comment, clientTimestamp, mimeType, photos } = req.body ?? {}

  if (!Array.isArray(photos) || photos.length === 0) {
    res.status(400).json({ message: 'photos (arreglo) es requerido.' }); return
  }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) {
      res.status(404).json({ message: `Producto "${productCode}" no encontrado en esta operación.` }); return
    }

    const product = products[productIdx]
    // Reabrir si estaba completado (permite seguir agregando fotos).
    if (product.status === 'COMPLETADO') {
      await col.updateOne({ trackingCode }, { $set: { [`lineaBlanca.${productIdx}.status`]: 'EN_PROCESO' } })
    }

    const { uploadToDrive } = await import('../lib/drive-upload.js')
    const vehicleFolder = operation.vehiclePlate
      ? `${operation.operationType}_${operation.vehiclePlate}`
      : `${operation.operationType}_${trackingCode}`
    const stepName = LINEA_BLANCA_STEPS[0] ?? 'Registro fotográfico'
    const safeStepName = stepName.replace(/[^a-zA-Z0-9]/g, '_')

    // Claves de idempotencia ya presentes en el producto.
    const existingKeys = existingClientKeys(product.photos ?? [])
    let photoNo = (product.photos ?? []).length

    const records: PhotoRecord[] = []
    const errors: string[] = []
    let skipped = 0

    // Subir en SECUENCIA; un solo $push al final.
    for (let i = 0; i < photos.length; i++) {
      const item = photos[i] ?? {}
      const base64Image = item.base64Image
      if (!base64Image) { errors.push(`Foto ${i + 1}: sin imagen`); continue }

      const itemKey = item.clientKey ? String(item.clientKey) : ''
      if (isDuplicateKey(existingKeys, itemKey)) { skipped++; continue }

      const fileName = `${trackingCode}_LB_${productCode}_foto${photoNo + 1}_${safeStepName}.jpg`
      const driveResult = await uploadToDrive({
        base64Image,
        fileName,
        mimeType: mimeType || 'image/jpeg',
        subfolderName: vehicleFolder,
        subSubfolderName: productCode,
        companyId: operation.companyId as string | undefined,
      })

      if (driveResult.status === 'error') {
        if ((driveResult.message ?? '').includes('no configurado')) {
          res.status(502).json({ message: 'Almacenamiento no configurado en el servidor (R2 o GitHub).' }); return
        }
        // Fallo transitorio: no persistir marcador roto; pedir reintento (503).
        // La idempotencia por clientKey evita duplicar las ya subidas.
        console.error(`[linea-blanca] Subida fallida (batch) foto ${i + 1}: ${driveResult.message}`)
        res.status(503).json({ message: 'No se pudo subir la imagen al almacenamiento. Reintenta en unos segundos.', detail: driveResult.message }); return
      }

      const fileId = driveResult.fileId || 'pending'
      const driveUrl = driveResult.driveUrl || 'pending-verification'
      const photoComment = (item.comment ?? (i === 0 ? comment : '') ?? '').trim()

      records.push({
        stepIndex: 0,
        stepName,
        driveUrl,
        fileId,
        productCode,
        ...(photoComment ? { comment: photoComment } : {}),
        ...(groupId ? { groupId: String(groupId) } : {}),
        ...(itemKey ? { clientKey: itemKey } : {}),
        photoType: 'producto',
        timestamp: normalizeClientTimestamp(item.clientTimestamp ?? clientTimestamp),
      })
      if (itemKey) existingKeys.add(itemKey)
      photoNo++
    }

    if (records.length === 0) {
      if (skipped > 0) { res.json({ message: 'Fotos ya registradas (idempotente).', count: 0, skipped, errors }); return }
      res.status(422).json({ message: 'No se pudo procesar ninguna foto.', errors }); return
    }

    // UN SOLO push con todas las fotos del producto (evita carrera).
    await col.updateOne(
      { trackingCode, 'lineaBlanca.productCode': productCode },
      {
        $push: { [`lineaBlanca.${productIdx}.photos`]: { $each: records } },
        $set: { updatedAt: new Date().toISOString() },
      } as unknown as Record<string, unknown>,
    )

    // Sincronizar a operaciones vinculadas (si las hay), evitando duplicados por clientKey/timestamp.
    const currentLinkedTo = product.linkedTo ?? []
    for (const linkedTrackingCode of currentLinkedTo) {
      try {
        const linkedOp = await col.findOne({ trackingCode: linkedTrackingCode })
        if (!linkedOp) continue
        const linkedProducts = (linkedOp.lineaBlanca as LineaBlancaProduct[]) ?? []
        const linkedProductIdx = linkedProducts.findIndex((p) => p.productCode === productCode)
        if (linkedProductIdx === -1) continue
        const existing = linkedProducts[linkedProductIdx].photos ?? []
        const existKeys = new Set(existing.map((p) => p.clientKey).filter(Boolean) as string[])
        const existTs = new Set(existing.map((p) => p.timestamp))
        const toSync = records.filter((r) => (r.clientKey ? !existKeys.has(r.clientKey) : !existTs.has(r.timestamp)))
        if (toSync.length === 0) continue
        await col.updateOne(
          { trackingCode: linkedTrackingCode, 'lineaBlanca.productCode': productCode },
          {
            $push: { [`lineaBlanca.${linkedProductIdx}.photos`]: { $each: toSync } },
            $set: { updatedAt: new Date().toISOString() },
          } as unknown as Record<string, unknown>,
        )
      } catch (syncErr) {
        console.warn(`[linea-blanca] Error al sincronizar batch a ${linkedTrackingCode}:`, syncErr)
      }
    }

    res.json({ message: `${records.length} foto(s) registrada(s).`, count: records.length, skipped, errors, synced: currentLinkedTo.length })
  } catch (err) {
    console.error('[linea-blanca] Error en photo-batch:', err)
    res.status(500).json({ message: 'Error al procesar las fotos del producto.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode/complete
 * Marca una operación como completada.
 */
operationsRouter.patch('/:trackingCode/complete', async (req, res) => {
  const { trackingCode } = req.params
  const { clientTimestamp } = req.body ?? {}

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })

    if (!operation) {
      res.status(404).json({ message: 'Operación no encontrada.' })
      return
    }

    // Verifica que todos los pasos OBLIGATORIOS tengan al menos 1 foto
    const steps = getStepsForType(operation.operationType as OperationType)
    const opType = operation.operationType as OperationType
    const optionalSteps = OPTIONAL_STEPS[opType] ?? []
    const photos = operation.photos as PhotoRecord[]
    const lineaBlanca = (operation.lineaBlanca ?? []) as Array<{ photos: unknown[] }>
    const completedSteps = new Set(photos.map((p) => p.stepIndex))

    for (let i = 0; i < steps.length; i++) {
      if (optionalSteps.includes(i)) continue
      if (!completedSteps.has(i)) {
        res.status(400).json({ message: `Falta la foto del paso "${steps[i]}".`, missingStep: i })
        return
      }
    }

    // Requiere al menos 1 foto o 1 producto de línea blanca
    if (photos.length === 0 && lineaBlanca.length === 0) {
      res.status(400).json({ message: 'Debe tener al menos una foto o un producto registrado para completar.' })
      return
    }

    const completedAt = normalizeClientTimestamp(clientTimestamp)
    await col.updateOne(
      { trackingCode },
      { $set: { status: 'COMPLETADO', completedAt, updatedAt: new Date().toISOString() } },
    )

    void logActivity(
      operation.companyId as string | undefined,
      'operacion_completada',
      `Operación ${trackingCode} completada por ${operation.operatorName}`,
      { trackingCode, operationType: operation.operationType, operatorName: operation.operatorName },
    )

    // Envío automático por correo si está habilitado para la empresa.
    try {
      const settings = operation.companyId
        ? await getDb().collection('company_settings').findOne({ companyId: operation.companyId })
        : null
      if (settings?.sendEmail === true && settings?.emailTo) {
        const opForEmail = {
          trackingCode: operation.trackingCode,
          operationType: operation.operationType,
          vehiclePlate: operation.vehiclePlate,
          operatorName: operation.operatorName,
          createdAt: operation.createdAt,
          completedAt,
          photos: operation.photos as Array<{ driveUrl?: string; comment?: string; stepName?: string }>,
          products: (operation.lineaBlanca ?? []) as Array<{
            productCode: string
            labelData?: { descripcion?: string }
            photos: Array<{ driveUrl?: string; comment?: string }>
          }>,
        }
        void sendOperationEmail(settings.emailTo as string, opForEmail)
      }
    } catch (err) {
      console.error('[operations] Error al enviar correo de completado:', err)
    }

    res.json({ message: 'Operación marcada como completada.', trackingCode, completedAt })
  } catch (err) {
    console.error('[operations] Error al completar:', err)
    res.status(500).json({ message: 'Error al completar la operación.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode/reopen
 * Reabre una operación completada para edición.
 */
operationsRouter.patch('/:trackingCode/reopen', async (req, res) => {
  const { trackingCode } = req.params
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    await col.updateOne(
      { trackingCode },
      { $set: { status: 'EN_PROCESO', updatedAt: new Date().toISOString() } },
    )
    res.json({ message: 'Operación reabierta para edición.', trackingCode })
  } catch (err) {
    console.error('[operations] Error al reabrir:', err)
    res.status(500).json({ message: 'Error al reabrir la operación.' })
  }
})

/**
 * POST /api/operations/:trackingCode/attachment
 * Anexa un adjunto YA subido (audio o documento) como item del registro.
 * Body: { url, mediaType: 'audio'|'document', fileName?, mimeType?, comment? }
 */
operationsRouter.post('/:trackingCode/attachment', async (req, res) => {
  const { trackingCode } = req.params
  const { url, mediaType, fileName, mimeType, comment } = req.body ?? {}
  if (!url) { res.status(400).json({ message: 'url es requerida.' }); return }
  if (mediaType !== 'audio' && mediaType !== 'document') {
    res.status(400).json({ message: "mediaType debe ser 'audio' o 'document'." }); return
  }
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const record = {
      stepIndex: 0,
      stepName: mediaType === 'audio' ? 'Audio' : 'Documento',
      driveUrl: String(url),
      fileId: 'attachment',
      mediaType,
      ...(fileName ? { fileName: String(fileName) } : {}),
      ...(mimeType ? { mimeType: String(mimeType) } : {}),
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
      timestamp: new Date().toISOString(),
    }

    await col.updateOne({ trackingCode }, { $push: { photos: record } as never, $set: { updatedAt: new Date().toISOString() } })

    void logActivity(
      operation.companyId as string | undefined,
      mediaType === 'audio' ? 'audio_agregado' : 'documento_agregado',
      `${mediaType === 'audio' ? 'Audio' : 'Documento'} agregado al registro ${trackingCode}`,
      { trackingCode, fileName },
    )

    res.status(201).json({ message: 'Adjunto agregado al registro.', record })
  } catch (err) {
    console.error('[operations] Error al agregar adjunto:', err)
    res.status(500).json({ message: 'Error al agregar el adjunto.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode
 * Actualiza datos de la operación (placa, operador, etc.)
 */
operationsRouter.patch('/:trackingCode', async (req, res) => {
  const { trackingCode } = req.params
  const { vehiclePlate, operatorName, newTrackingCode, createdAt, updatedAt, locationId, isTransfer, origin, destination } = req.body ?? {}

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const updates: Record<string, unknown> = { updatedAt: updatedAt ?? new Date().toISOString() }
    if (vehiclePlate?.trim()) updates.vehiclePlate = vehiclePlate.trim()
    if (operatorName?.trim()) updates.operatorName = operatorName.trim()
    if (createdAt) updates.createdAt = createdAt

    // Ubicación (origen/destino): solo si la función está habilitada. Si cambia el
    // destino, se re-registran los movimientos de los productos hacia el nuevo
    // destino (idempotente por sameLocation).
    const { enabled: locEnabled, places } = await getCompanyLocationCtx(operation.companyId as string | undefined)
    let newDestRef: LocationRef | null | undefined // undefined = no tocar
    if (locEnabled && (destination !== undefined || locationId !== undefined)) {
      const destInput = destination ?? (typeof locationId === 'string' && locationId.trim()
        ? { type: 'lugar', id: locationId.trim() }
        : null)
      newDestRef = destInput ? toLocationRef(destInput, places) : null
      updates.destination = newDestRef ?? undefined
      updates.locationId = newDestRef?.type === 'lugar' ? newDestRef.id : undefined
      updates.locationName = newDestRef?.name
    }
    if (locEnabled && origin !== undefined) {
      updates.origin = (origin ? toLocationRef(origin, places) : null) ?? undefined
    }
    if (locEnabled && isTransfer !== undefined) {
      updates.isTransfer = isTransfer === true || undefined
    }

    if (newTrackingCode?.trim() && newTrackingCode.trim() !== trackingCode) {
      // Verifica que el nuevo trackingCode no exista
      const existing = await col.findOne({ trackingCode: newTrackingCode.trim() })
      if (existing) { res.status(409).json({ message: `El tracking code "${newTrackingCode}" ya existe.` }); return }
      updates.trackingCode = newTrackingCode.trim()
    }

    await col.updateOne({ trackingCode }, { $set: updates })

    // Si cambió el destino, re-registra el movimiento de cada producto de la
    // operación hacia el nuevo destino (idempotente: no inserta si ya está ahí).
    if (newDestRef) {
      const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
      const originRef = (updates.origin as LocationRef | undefined) ?? (operation.origin as LocationRef | undefined) ?? null
      for (const p of products) {
        await recordMovement({
          companyId: operation.companyId as string,
          productCode: p.productCode,
          destination: newDestRef,
          originExplicit: originRef,
          trackingCode,
        })
      }
    }

    res.json({ message: 'Operación actualizada.', ...updates })
  } catch (err) {
    console.error('[operations] Error al actualizar:', err)
    res.status(500).json({ message: 'Error al actualizar.' })
  }
})

/**
 * DELETE /api/operations/:trackingCode
 * Elimina una operación de MongoDB y todas sus imágenes en R2.
 */
operationsRouter.delete('/:trackingCode', async (req, res) => {
  const { trackingCode } = req.params

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })

    if (!operation) {
      res.status(404).json({ message: 'Operación no encontrada.' })
      return
    }

    // Archivos que otros registros siguen usando (productos vinculados comparten
    // archivos): se conservan. Si no se puede verificar, no se borra ningún
    // archivo (solo el registro), para no dejar sin fotos a otros registros.
    const allPhotos = [
      ...((operation.photos as PhotoRecord[]) ?? []),
      ...(((operation.lineaBlanca as LineaBlancaProduct[]) ?? []).flatMap((p) => p.photos ?? [])),
    ]
    let stillUsed: Set<string> | null = null
    try {
      stillUsed = await referencedPhotoIdsExcept({ companyId: operation.companyId as string | undefined, excludeOps: [trackingCode] })
    } catch (refErr) {
      console.warn('[delete] No se pudo verificar fotos compartidas; se conservan los archivos:', refErr instanceof Error ? refErr.message : refErr)
    }

    let storageDeleted = 0
    if (stillUsed) {
      const prefix = `operations/${trackingCode}/`
      // Por prefijo solo si ningún registro vivo usa archivos de esa carpeta.
      if (!isPrefixReferenced(prefix, stillUsed)) {
        try {
          const { deleteByPrefix } = await import('../lib/storage.js')
          storageDeleted = await deleteByPrefix(prefix)
        } catch (storageErr) {
          console.warn('[delete] Error al eliminar objetos de R2:', storageErr instanceof Error ? storageErr.message : storageErr)
        }
      }
      // GitHub y archivos sueltos, saltando los compartidos.
      const used = stillUsed
      await deleteAllPhotosStorage(allPhotos.filter((ph) => !isPhotoShared(ph, used)))
    }

    // Siempre eliminar de MongoDB, independiente del resultado del storage
    await col.deleteOne({ trackingCode })

    res.json({
      message: `Operación ${trackingCode} eliminada.`,
      storageDeleted,
    })
  } catch (err) {
    console.error('[operations] Error al eliminar:', err)
    res.status(500).json({ message: 'Error al eliminar la operación.' })
  }
})

/**
 * DELETE /api/operations/:trackingCode/linea-blanca/:productCode
 * Elimina un producto completo (con todas sus fotos) de la operación.
 */
operationsRouter.delete('/:trackingCode/linea-blanca/:productCode', async (req, res) => {
  const { trackingCode, productCode } = req.params
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productToDelete = products.find((p) => p.productCode === productCode)
    const filtered = products.filter((p) => p.productCode !== productCode)

    if (filtered.length === products.length) {
      res.status(404).json({ message: `Producto "${productCode}" no encontrado.` })
      return
    }

    // Eliminar las imágenes del producto en R2 (prefijo) y en GitHub (por foto),
    // conservando las que otro registro (o el mismo, en otro producto) sigue usando.
    if (productToDelete) {
      let stillUsed: Set<string> | null = null
      try {
        stillUsed = await referencedPhotoIdsExcept({
          companyId: operation.companyId as string | undefined,
          excludeProduct: { trackingCode, productCode },
        })
      } catch (refErr) {
        console.warn('[operations] No se pudo verificar fotos compartidas; se conservan los archivos del producto:', refErr instanceof Error ? refErr.message : refErr)
      }
      if (stillUsed) {
        const prefix = `operations/${trackingCode}/${productCode.replace(/[^a-zA-Z0-9._-]/g, '_')}/`
        if (!isPrefixReferenced(prefix, stillUsed)) {
          try {
            const { deleteByPrefix } = await import('../lib/storage.js')
            await deleteByPrefix(prefix)
          } catch (e) { console.warn('[operations] Error al eliminar imágenes del producto en R2:', e instanceof Error ? e.message : e) }
        }
        const used = stillUsed
        await deleteAllPhotosStorage((productToDelete.photos ?? []).filter((ph) => !isPhotoShared(ph, used)))
      }
    }

    await col.updateOne({ trackingCode }, { $set: { lineaBlanca: filtered, updatedAt: new Date().toISOString() } })
    // Si el producto ya no queda en ningún registro y fue creado en un registro, se borra del catálogo
    await cleanupCatalogIfOrphan(operation.companyId as string | undefined, productCode)
    res.json({ message: `Producto "${productCode}" eliminado.`, remaining: filtered.length })
  } catch (err) {
    console.error('[operations] Error al eliminar producto:', err)
    res.status(500).json({ message: 'Error al eliminar producto.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode/linea-blanca/:productCode/photo/:photoIndex
 * Actualiza el fileId y/o driveUrl de una foto de producto (útil para corrección de rutas).
 * Body: { fileId?, driveUrl?, comment? }
 */
operationsRouter.patch('/:trackingCode/linea-blanca/:productCode/photo/:photoIndex', async (req, res) => {
  const { trackingCode, productCode, photoIndex } = req.params
  const { fileId, driveUrl, comment } = req.body ?? {}
  const idx = Number(photoIndex)
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }
    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }
    const photos = products[productIdx].photos
    if (idx < 0 || idx >= photos.length) { res.status(400).json({ message: 'Índice de foto inválido.' }); return }
    if (fileId) photos[idx].fileId = fileId
    if (driveUrl) photos[idx].driveUrl = driveUrl
    if (comment !== undefined) photos[idx].comment = comment
    await col.updateOne({ trackingCode }, { $set: { [`lineaBlanca.${productIdx}.photos`]: photos, updatedAt: new Date().toISOString() } })
    res.json({ message: 'Foto actualizada.', photo: photos[idx] })
  } catch (err) {
    console.error('[operations] Error al actualizar foto de producto:', err)
    res.status(500).json({ message: 'Error al actualizar foto.' })
  }
})

/**
 * PATCH /api/photos/:trackingCode/:photoIndex
 * Actualiza el fileId y/o driveUrl de una foto general de la operación.
 * Body: { fileId?, driveUrl?, comment? }
 */

/**
 * DELETE /api/operations/:trackingCode/linea-blanca/:productCode/photo/:photoIndex
 * Elimina una foto individual de un producto.
 */
operationsRouter.delete('/:trackingCode/linea-blanca/:productCode/photo/:photoIndex', async (req, res) => {
  const { trackingCode, productCode, photoIndex } = req.params
  const idx = Number(photoIndex)
  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }

    const photos = products[productIdx].photos
    if (idx < 0 || idx >= photos.length) { res.status(400).json({ message: 'Índice de foto inválido.' }); return }

    // Eliminar archivo del almacenamiento (R2 y/o GitHub)
    const photoToDelete = photos[idx]
    await deletePhotoStorage(photoToDelete)

    photos.splice(idx, 1)
    // Si quitó fotos y estaba completado, volver a EN_PROCESO
    if (products[productIdx].status === 'COMPLETADO') {
      products[productIdx].status = 'EN_PROCESO'
    }

    await col.updateOne({ trackingCode }, { $set: { lineaBlanca: products, updatedAt: new Date().toISOString() } })
    res.json({ message: 'Foto eliminada.', remaining: photos.length })
  } catch (err) {
    console.error('[operations] Error al eliminar foto de producto:', err)
    res.status(500).json({ message: 'Error al eliminar foto.' })
  }
})

/**
 * POST /api/operations/:trackingCode/linea-blanca/:productCode/link
 * Vincula (copia) un producto a otra operación existente.
 * Las fotos se sincronizan automáticamente entre operaciones vinculadas.
 * Body: { targetTrackingCode }
 */
operationsRouter.post('/:trackingCode/linea-blanca/:productCode/link', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { targetTrackingCode } = req.body ?? {}

  if (!targetTrackingCode?.trim()) {
    res.status(400).json({ message: 'targetTrackingCode es requerido.' })
    return
  }

  if (targetTrackingCode.trim() === trackingCode) {
    res.status(400).json({ message: 'No puedes vincular un producto a la misma operación.' })
    return
  }

  try {
    const col = getOperationsCollection()

    // Buscar operación origen
    const sourceOp = await col.findOne({ trackingCode })
    if (!sourceOp) { res.status(404).json({ message: 'Operación origen no encontrada.' }); return }

    const sourceProducts = (sourceOp.lineaBlanca as LineaBlancaProduct[]) ?? []
    const sourceIdx = sourceProducts.findIndex((p) => p.productCode === productCode)
    if (sourceIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado en operación origen.` }); return }
    const product = sourceProducts[sourceIdx]

    // Buscar operación destino
    const targetOp = await col.findOne({ trackingCode: targetTrackingCode.trim() })
    if (!targetOp) { res.status(404).json({ message: `Operación destino "${targetTrackingCode}" no encontrada.` }); return }

    // Permitir vincular aunque la operación destino esté completada

    // Verificar que no exista ya en la operación destino
    const targetProducts = (targetOp.lineaBlanca as LineaBlancaProduct[]) ?? []
    if (targetProducts.some((p) => p.productCode === productCode)) {
      res.status(409).json({ message: `El producto "${productCode}" ya existe en la operación destino.` })
      return
    }

    // Copiar el producto con las fotos ya existentes y agregar linkedTo
    const sourceLinkedTo = product.linkedTo ?? []
    const newSourceLinkedTo = [...new Set([...sourceLinkedTo, targetTrackingCode.trim()])]

    const linkedProduct: LineaBlancaProduct = {
      productCode: product.productCode,
      labelData: product.labelData ? { ...product.labelData } : undefined,
      isLineaBlanca: product.isLineaBlanca,
      linkedTo: [trackingCode], // la operación destino sabe que está vinculada con la origen
      photos: [...product.photos], // copiar fotos existentes
      status: 'EN_PROCESO',
      createdAt: new Date().toISOString(),
    }

    // Actualizar operación destino: agregar producto
    await col.updateOne(
      { trackingCode: targetTrackingCode.trim() },
      {
        $push: { lineaBlanca: linkedProduct },
        $set: { updatedAt: new Date().toISOString() },
      } as unknown as Record<string, unknown>,
    )

    // Actualizar operación origen: marcar linkedTo en el producto fuente
    await col.updateOne(
      { trackingCode, 'lineaBlanca.productCode': productCode },
      { $set: { [`lineaBlanca.${sourceIdx}.linkedTo`]: newSourceLinkedTo, updatedAt: new Date().toISOString() } },
    )

    res.status(201).json({
      message: `Producto "${productCode}" vinculado a operación ${targetTrackingCode}. Las fotos se sincronizarán automáticamente.`,
      targetTrackingCode: targetTrackingCode.trim(),
      targetOperationType: targetOp.operationType,
      product: linkedProduct,
    })
  } catch (err) {
    console.error('[operations] Error al vincular producto:', err)
    res.status(500).json({ message: 'Error al vincular producto.' })
  }
})

/**
 * POST /api/operations/:trackingCode/linea-blanca/:productCode/unlink
 * Desvincula y elimina el producto de la operación actual.
 * Quita la referencia linkedTo en la operación vinculada.
 * Body: { targetTrackingCode }
 */
operationsRouter.post('/:trackingCode/linea-blanca/:productCode/unlink', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { targetTrackingCode } = req.body ?? {}

  if (!targetTrackingCode?.trim()) {
    res.status(400).json({ message: 'targetTrackingCode es requerido.' })
    return
  }

  try {
    const col = getOperationsCollection()

    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }

    // Eliminar el producto de esta operación
    const filtered = products.filter((p) => p.productCode !== productCode)
    await col.updateOne(
      { trackingCode },
      { $set: { lineaBlanca: filtered, updatedAt: new Date().toISOString() } },
    )

    // Quitar este trackingCode del linkedTo del producto en la operación vinculada
    const targetOp = await col.findOne({ trackingCode: targetTrackingCode.trim() })
    if (targetOp) {
      const targetProducts = (targetOp.lineaBlanca as LineaBlancaProduct[]) ?? []
      const targetPIdx = targetProducts.findIndex((p) => p.productCode === productCode)
      if (targetPIdx !== -1) {
        const targetLinked = targetProducts[targetPIdx].linkedTo ?? []
        const newTargetLinked = targetLinked.filter((tc) => tc !== trackingCode)
        await col.updateOne(
          { trackingCode: targetTrackingCode.trim(), 'lineaBlanca.productCode': productCode },
          { $set: { [`lineaBlanca.${targetPIdx}.linkedTo`]: newTargetLinked, updatedAt: new Date().toISOString() } },
        )
      }
    }

    await cleanupCatalogIfOrphan(operation.companyId as string | undefined, productCode)
    res.json({ message: `Producto "${productCode}" desvinculado y eliminado de esta operación.` })
  } catch (err) {
    console.error('[operations] Error al desvincular:', err)
    res.status(500).json({ message: 'Error al desvincular producto.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode/linea-blanca/:productCode/rename
 * Renombra un producto (cambia su productCode).
 * Body: { newProductCode }
 */
operationsRouter.patch('/:trackingCode/linea-blanca/:productCode/rename', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { newProductCode } = req.body ?? {}

  if (!newProductCode?.trim()) {
    res.status(400).json({ message: 'newProductCode es requerido.' })
    return
  }

  const newCode = newProductCode.trim()
  if (newCode === productCode) {
    res.json({ message: 'Sin cambios.' })
    return
  }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }

    if (products.some((p) => p.productCode.toLowerCase() === newCode.toLowerCase())) {
      res.status(409).json({ message: `Ya existe un producto con código "${newCode}" en esta operación.` })
      return
    }

    // Unicidad GLOBAL por empresa: el nuevo código no puede existir en otra operación
    const companyId = operation.companyId as string | undefined
    const escaped = newCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const dupFilter: Record<string, unknown> = {
      trackingCode: { $ne: trackingCode },
      'lineaBlanca.productCode': { $regex: `^${escaped}$`, $options: 'i' },
    }
    if (companyId) dupFilter.companyId = companyId
    const duplicate = await col.findOne(dupFilter)
    if (duplicate) {
      res.status(409).json({ message: `El código "${newCode}" ya existe en la operación ${duplicate.trackingCode}.` })
      return
    }

    await col.updateOne(
      { trackingCode, 'lineaBlanca.productCode': productCode },
      { $set: { [`lineaBlanca.${productIdx}.productCode`]: newCode, updatedAt: new Date().toISOString() } },
    )

    // Sincroniza el catálogo maestro: renombra la entrada y limpia la vieja si quedó huérfana
    await upsertCatalogProduct(companyId, newCode, products[productIdx].labelData?.descripcion, 'registro')
    await cleanupCatalogIfOrphan(companyId, productCode)

    res.json({ message: `Producto renombrado de "${productCode}" a "${newCode}".` })
  } catch (err) {
    console.error('[operations] Error al renombrar:', err)
    res.status(500).json({ message: 'Error al renombrar producto.' })
  }
})

/**
 * PATCH /api/operations/:trackingCode/linea-blanca/:productCode/label
 * Edita los datos de etiqueta de un producto.
 * Body: { labelData: { sku?, descripcion?, poNumber?, ... } }
 */
operationsRouter.patch('/:trackingCode/linea-blanca/:productCode/label', async (req, res) => {
  const { trackingCode, productCode } = req.params
  const { labelData } = req.body ?? {}

  if (!labelData || typeof labelData !== 'object') {
    res.status(400).json({ message: 'labelData es requerido.' })
    return
  }

  try {
    const col = getOperationsCollection()
    const operation = await col.findOne({ trackingCode })
    if (!operation) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const products = (operation.lineaBlanca as LineaBlancaProduct[]) ?? []
    const productIdx = products.findIndex((p) => p.productCode === productCode)
    if (productIdx === -1) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }

    await col.updateOne(
      { trackingCode, 'lineaBlanca.productCode': productCode },
      { $set: { [`lineaBlanca.${productIdx}.labelData`]: labelData, updatedAt: new Date().toISOString() } },
    )

    res.json({ message: 'Datos de etiqueta actualizados.', labelData })
  } catch (err) {
    console.error('[operations] Error al editar etiqueta:', err)
    res.status(500).json({ message: 'Error al editar datos de etiqueta.' })
  }
})

/**
 * POST /api/operations/:trackingCode/send-email
 * Envía un registro completo por correo electrónico al destinatario configurado
 * (o al "to" del body). Requiere que sendEmail esté habilitado o que se envíe "to".
 * Body: { to? }
 */
operationsRouter.post('/:trackingCode/send-email', async (req, res) => {
  const { trackingCode } = req.params
  const { to: toOverride } = req.body ?? {}

  try {
    const col = getOperationsCollection()
    const op = await col.findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = op.companyId as string | undefined
    let to = (toOverride ?? '').trim()

    if (!to && companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId })
      to = (settings?.emailTo as string) ?? ''
    }
    if (!to) {
      res.status(400).json({ message: 'No hay correo destinatario configurado para esta empresa.' })
      return
    }

    const opForEmail = {
      trackingCode: op.trackingCode,
      operationType: op.operationType,
      vehiclePlate: op.vehiclePlate,
      operatorName: op.operatorName,
      createdAt: op.createdAt,
      completedAt: op.completedAt,
      photos: (op.photos ?? []) as Array<{ driveUrl?: string; comment?: string; stepName?: string; mediaType?: 'image' | 'audio' | 'document'; fileName?: string; mimeType?: string }>,
      products: (op.lineaBlanca ?? []) as Array<{
        productCode: string
        labelData?: { descripcion?: string }
        photos: Array<{ driveUrl?: string; comment?: string }>
      }>,
    }

    const sent = await sendOperationEmail(to, opForEmail)
    if (!sent) {
      res.status(503).json({ message: 'Servidor de correo (SMTP) no configurado. Define SMTP_HOST, SMTP_USER, SMTP_PASS en las variables de entorno.' })
      return
    }

    void logActivity(companyId, 'correo_enviado', `Registro ${trackingCode} enviado por correo a ${to}`, { trackingCode, to })
    res.json({ message: `Registro enviado por correo a ${to}.`, to })
  } catch (err) {
    console.error('[operations] Error al enviar correo:', err)
    res.status(500).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el correo.' })
  }
})

/**
 * GET /api/activity?companyId=xxx&limit=50
 * Devuelve el log de actividad de la empresa (más recientes primero).
 */
operationsRouter.get('/activity', async (req, res) => {
  const { companyId, limit } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const lim = Math.min(Number(limit) || 50, 200)
    const entries = await getDb()
      .collection('activity_log')
      .find({ companyId })
      .sort({ createdAt: -1 })
      .limit(lim)
      .toArray()
    res.json({ entries })
  } catch (err) {
    console.error('[activity] Error al leer:', err)
    res.status(500).json({ message: 'Error al leer el log de actividad.' })
  }
})

/**
 * POST /api/activity
 * Registra manualmente una entrada en el log de actividad de la empresa.
 * Body: { companyId, action, detail, meta? }
 */
operationsRouter.post('/activity', async (req, res) => {
  const { companyId, action, detail, meta } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!action?.trim() || !detail?.trim()) {
    res.status(400).json({ message: 'action y detail son requeridos.' })
    return
  }
  try {
    const entry = {
      companyId: companyId.trim(),
      action: String(action).trim(),
      detail: String(detail).trim(),
      meta: meta ?? {},
      createdAt: new Date().toISOString(),
    }
    await getDb().collection('activity_log').insertOne(entry)
    res.json({ message: 'Actividad registrada.', entry })
  } catch (err) {
    console.error('[activity] Error al registrar:', err)
    res.status(500).json({ message: 'Error al registrar la actividad.' })
  }
})
