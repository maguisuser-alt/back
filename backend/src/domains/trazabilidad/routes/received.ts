/**
 * received.ts — Productos marcados como RECIBIDOS, compartidos por EMPRESA.
 *
 * Cuando un empleado marca un producto como recibido, la marca se guarda en
 * MongoDB. Como todos los empleados de la empresa consultan el mismo servidor,
 * TODOS ven la marca en vivo (no es un estado local del dispositivo).
 *
 * RECEPCIONES (`scope`): las marcas se agrupan por recepción (una carga, un
 * conteo). `scope = ''` es la recepción "General" (comportamiento histórico).
 * Cada recepción tiene su propio conteo: marcar en una no suma en otra.
 *
 * Colecciones:
 *  - `received_products`  { companyId, scope, productCode, productCodeLower, quantity, receivedBy, receivedAt, trackingCode?, sheetId? }
 *      Índice único (companyId, scope, productCodeLower).
 *  - `received_history`   una entrada por cada cambio (quién, cuánto, cuándo) → historial y DESHACER.
 *  - `received_scopes`    recepciones creadas por la empresa.
 *  - `scan_not_found`     códigos escaneados que no estaban en la DATA.
 */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getDb } from '../lib/mongodb.js'
import { legacyTargetSheet, sheetScopedRowKey } from '../lib/sheet-marks.js'

export const receivedRouter = Router()

const COLLECTION = 'received_products'
const HISTORY = 'received_history'
const SCOPES = 'received_scopes'
const NOT_FOUND = 'scan_not_found'

/**
 * Prepara índices una sola vez:
 *  - las marcas antiguas (sin `scope`) pasan a la recepción General ('');
 *  - el índice único pasa de (empresa, código) a (empresa, recepción, código).
 */
let indexEnsured = false
async function ensureIndex() {
  if (indexEnsured) return
  try {
    const db = getDb()
    const col = db.collection(COLLECTION)
    await col.updateMany({ scope: { $exists: false } }, { $set: { scope: '' } })
    await col.updateMany({ rowKey: { $exists: false } }, { $set: { rowKey: '' } })
    try { await col.dropIndex('company_product_unique') } catch { /* no existía */ }
    try { await col.dropIndex('company_scope_product_unique') } catch { /* no existía */ }
    await col.createIndex(
      { companyId: 1, scope: 1, productCodeLower: 1, rowKey: 1 },
      { unique: true, name: 'company_scope_product_row_unique' },
    )
    await db.collection(HISTORY).createIndex({ companyId: 1, scope: 1, productCodeLower: 1, at: -1 }, { name: 'history_lookup' })
    await db.collection(HISTORY).createIndex({ id: 1 }, { unique: true, name: 'history_id_unique' })
    await db.collection(SCOPES).createIndex({ companyId: 1, id: 1 }, { unique: true, name: 'scope_unique' })
    await db.collection(NOT_FOUND).createIndex({ companyId: 1, codeLower: 1 }, { unique: true, name: 'notfound_unique' })
    indexEnsured = true
  } catch (err) {
    /* si falla, se reintenta en el próximo request */
    console.warn('[received] No se pudieron preparar los índices:', err)
  }
}

interface ReceivedDoc {
  companyId: string
  scope: string
  productCode: string
  productCodeLower: string
  receivedBy: string
  receivedAt: string
  trackingCode?: string
  /** Unidades marcadas del producto (compartidas por la empresa). */
  quantity?: number
  /** Tabla DATA desde la que se marcó (informativo). */
  sheetId?: string
  /**
   * Fila concreta cuando el código se REPITE en la tabla (p. ej. "sheet:2" =
   * 2.ª fila con ese código). '' = marca del código (código único).
   */
  rowKey: string
}

/** Fila normalizada ('' = código). */
function rowKeyOf(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 120) : ''
}

interface HistoryDoc {
  id: string
  companyId: string
  scope: string
  productCode: string
  productCodeLower: string
  rowKey?: string
  /** Cantidad antes y después del cambio. */
  before: number
  after: number
  user: string
  at: string
  action: 'mark' | 'unmark' | 'undo'
  trackingCode?: string
  sheetId?: string
  /** true cuando este cambio ya se deshizo. */
  undone?: boolean
  /** En una entrada 'undo': id del cambio que deshizo. */
  undoOf?: string
}

/** Cantidad efectiva: los marcados antiguos (sin campo) valen 1. */
function qtyOf(doc: Record<string, unknown> | null | undefined): number {
  if (!doc) return 0
  const n = Number(doc.quantity)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

/** Recepción normalizada ('' = General). */
function scopeOf(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 80) : ''
}

async function isScopeClosed(companyId: string, scope: string): Promise<boolean> {
  const s = await getDb().collection(SCOPES).findOne({ companyId, id: scope }, { projection: { closed: 1 } })
  return s?.closed === true
}

async function logHistory(entry: Omit<HistoryDoc, 'id'>): Promise<string> {
  const id = randomUUID()
  try {
    await getDb().collection(HISTORY).insertOne({ id, ...entry })
  } catch (err) {
    console.warn('[received] No se pudo guardar el historial:', err)
  }
  return id
}

/**
 * Aplica un cambio a la cantidad de un producto en una recepción. Si la
 * cantidad llega a 0 o menos, se desmarca. Devuelve antes/después.
 */
async function applyChange(params: {
  companyId: string
  scope: string
  productCode: string
  rowKey?: string
  delta?: number | null
  setQty?: number | null
  user: string
  trackingCode?: string
  sheetId?: string
}): Promise<{ before: number; after: number; doc: ReceivedDoc }> {
  const { companyId, scope, productCode, rowKey = '', delta = null, setQty = null, user, trackingCode, sheetId } = params
  const col = getDb().collection(COLLECTION)
  const key = { companyId, scope, productCodeLower: productCode.toLowerCase(), rowKey }
  const meta: ReceivedDoc = {
    companyId,
    scope,
    productCode,
    productCodeLower: key.productCodeLower,
    rowKey,
    receivedBy: user,
    receivedAt: new Date().toISOString(),
    ...(trackingCode ? { trackingCode } : {}),
    ...(sheetId ? { sheetId } : {}),
  }

  const prev = await col.findOne(key, { projection: { quantity: 1 } })
  const before = qtyOf(prev)
  let after: number

  if (setQty !== null) {
    after = setQty
    if (after > 0) await col.updateOne(key, { $set: { ...meta, quantity: after } }, { upsert: true })
  } else if (delta !== null && delta !== 0) {
    // Los marcados antiguos no tienen `quantity` (valían 1): se normalizan
    // antes de sumar para que $inc parta de 1 y no de 0.
    await col.updateOne({ ...key, quantity: { $exists: false } }, { $set: { quantity: 1 } })
    const res = await col.findOneAndUpdate(
      key,
      { $inc: { quantity: delta }, $set: meta },
      { upsert: true, returnDocument: 'after' },
    )
    after = Number((res as { quantity?: number } | null)?.quantity ?? delta)
  } else {
    await col.updateOne(key, { $set: meta, $setOnInsert: { quantity: 1 } }, { upsert: true })
    after = qtyOf(await col.findOne(key, { projection: { quantity: 1 } }))
  }

  if (after <= 0) {
    await col.deleteOne(key)
    after = 0
  }
  return { before, after, doc: { ...meta, quantity: after } }
}

/**
 * GET /api/received?companyId=xxx[&scope=yyy]
 * Lista los productos marcados en una recepción ('' = General).
 */
receivedRouter.get('/', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  const scope = scopeOf(req.query.scope)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const docs = await getDb().collection(COLLECTION)
      .find({ companyId, scope }, { projection: { _id: 0, productCodeLower: 0, companyId: 0 } })
      .toArray()
    res.json({ received: docs.map((d) => ({ ...d, quantity: qtyOf(d) })) })
  } catch (err) {
    console.error('[received] Error al listar:', err)
    res.status(500).json({ message: 'Error al leer los productos recibidos.' })
  }
})

/**
 * POST /api/received
 * Body: { companyId?, scope?, productCode, trackingCode?, sheetId?, delta?, quantity? }
 *  - delta (p. ej. +1 / -1): suma/resta de forma atómica. Si llega a 0, se desmarca.
 *  - quantity: fija la cantidad exacta (0 = desmarcar).
 *  - sin delta ni quantity: marca con 1 si no estaba (compatibilidad).
 * Respuesta incluye `historyId` (para DESHACER).
 */
receivedRouter.post('/', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const scope = scopeOf(req.body?.scope)
  const productCode = String(req.body?.productCode ?? '').trim()
  const trackingCode = (req.body?.trackingCode as string) || undefined
  const sheetId = (req.body?.sheetId as string) || undefined
  // Cada tabla lleva su propio conteo: sin fila concreta, la marca es del
  // código DENTRO de esa tabla (rowKey = sheetId). Así marcar en una tabla no
  // marca el mismo código en otra.
  const rowKey = sheetScopedRowKey(rowKeyOf(req.body?.rowKey), sheetId)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!productCode) { res.status(400).json({ message: 'productCode es requerido.' }); return }

  const rawDelta = req.body?.delta
  const rawQty = req.body?.quantity
  const delta = rawDelta === undefined || rawDelta === null ? null : Math.trunc(Number(rawDelta))
  const setQty = rawQty === undefined || rawQty === null ? null : Math.trunc(Number(rawQty))
  if ((delta !== null && !Number.isFinite(delta)) || (setQty !== null && (!Number.isFinite(setQty) || setQty < 0))) {
    res.status(400).json({ message: 'delta/quantity deben ser números válidos.' }); return
  }

  try {
    await ensureIndex()
    if (scope && await isScopeClosed(companyId, scope)) {
      res.status(409).json({ message: 'Esta recepción está cerrada. Reábrela para seguir marcando.' }); return
    }
    const user = req.session?.user ?? 'desconocido'
    const { before, after, doc } = await applyChange({ companyId, scope, productCode, rowKey, delta, setQty, user, trackingCode, sheetId })
    const historyId = before === after
      ? undefined
      : await logHistory({
        companyId, scope, productCode, productCodeLower: doc.productCodeLower, rowKey,
        before, after, user, at: doc.receivedAt, action: after > 0 ? 'mark' : 'unmark',
        ...(trackingCode ? { trackingCode } : {}), ...(sheetId ? { sheetId } : {}),
      })

    if (after <= 0) {
      res.json({ message: 'Producto desmarcado.', removed: true, historyId, received: { productCode, scope, rowKey, quantity: 0 } })
      return
    }
    res.json({
      message: 'Producto marcado como recibido.',
      historyId,
      received: {
        productCode: doc.productCode,
        scope,
        rowKey,
        receivedBy: doc.receivedBy,
        receivedAt: doc.receivedAt,
        trackingCode: doc.trackingCode,
        sheetId: doc.sheetId,
        quantity: after,
      },
    })
  } catch (err) {
    console.error('[received] Error al marcar:', err)
    res.status(500).json({ message: 'Error al marcar el producto como recibido.' })
  }
})

/**
 * GET /api/received/history?companyId=xxx&scope=yyy[&productCode=zzz][&limit=20]
 * Últimos cambios (quién marcó cuánto y cuándo), del más reciente al más antiguo.
 */
/**
 * POST /api/received/migrate-sheet-scope
 * Body: { companyId?, defaultSheetId? }
 * Pasa las marcas ANTIGUAS "del código" (rowKey '') a su tabla, para que cada
 * tabla tenga su conteo propio. Por cada marca: tabla guardada en la marca →
 * tabla del último cambio del historial → `defaultSheetId` (DATA principal).
 * Es idempotente y seguro con varios equipos a la vez: cada marca antigua se
 * BORRA de forma atómica antes de sumarla en su tabla, así no se suma dos veces.
 */
receivedRouter.post('/migrate-sheet-scope', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const defaultSheetId = typeof req.body?.defaultSheetId === 'string' ? req.body.defaultSheetId : ''
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const db = getDb()
    const col = db.collection(COLLECTION)
    const legacy = await col.find({ companyId, rowKey: { $in: ['', null] } }).toArray()
    let moved = 0
    let skipped = 0
    for (const doc of legacy) {
      const scope = scopeOf(doc.scope)
      const codeLower = String(doc.productCodeLower ?? String(doc.productCode ?? '').toLowerCase())
      let histSheet = ''
      if (!doc.sheetId) {
        const h = await db.collection(HISTORY).findOne(
          { companyId, scope, productCodeLower: codeLower, sheetId: { $exists: true, $ne: '' } },
          { sort: { at: -1 }, projection: { sheetId: 1 } },
        )
        histSheet = String(h?.sheetId ?? '')
      }
      const target = legacyTargetSheet(doc.sheetId as string | undefined, histSheet, defaultSheetId)
      if (!target) { skipped++; continue }
      // Borrado atómico: si otro equipo ya la movió, aquí no se encuentra.
      const removed = await col.findOneAndDelete({ _id: doc._id, rowKey: { $in: ['', null] } })
      const gone = (removed as { value?: unknown } | null)?.value ?? removed
      if (!gone) continue
      const qty = qtyOf(doc)
      const key = { companyId, scope, productCodeLower: codeLower, rowKey: target }
      await col.updateOne({ ...key, quantity: { $exists: false } }, { $set: { quantity: 1 } })
      await col.updateOne(
        key,
        {
          $inc: { quantity: qty },
          $set: { receivedBy: doc.receivedBy ?? '', receivedAt: doc.receivedAt ?? new Date().toISOString(), sheetId: target },
          $setOnInsert: { productCode: doc.productCode, ...(doc.trackingCode ? { trackingCode: doc.trackingCode } : {}) },
        },
        { upsert: true },
      )
      moved++
    }
    res.json({ moved, skipped })
  } catch (err) {
    console.error('[received] Error al migrar marcas por tabla:', err)
    res.status(500).json({ message: 'No se pudieron separar las marcas por tabla.' })
  }
})

receivedRouter.get('/history', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  const scope = scopeOf(req.query.scope)
  const productCode = String(req.query.productCode ?? '').trim()
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const filter: Record<string, unknown> = { companyId, scope }
    if (productCode) {
      filter.productCodeLower = productCode.toLowerCase()
      filter.rowKey = rowKeyOf(req.query.rowKey) || { $in: ['', null] }
    }
    const items = await getDb().collection(HISTORY)
      .find(filter, { projection: { _id: 0, companyId: 0, productCodeLower: 0 } })
      .sort({ at: -1 })
      .limit(limit)
      .toArray()
    res.json({ history: items })
  } catch (err) {
    console.error('[received] Error al leer historial:', err)
    res.status(500).json({ message: 'Error al leer el historial.' })
  }
})

/**
 * POST /api/received/undo
 * Body: { companyId?, historyId }
 * Deshace UN cambio: aplica el cambio contrario de forma atómica (se respetan
 * las unidades que otros empleados marcaron después). Solo una vez por cambio.
 */
receivedRouter.post('/undo', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const historyId = String(req.body?.historyId ?? '').trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!historyId) { res.status(400).json({ message: 'historyId es requerido.' }); return }
  try {
    await ensureIndex()
    const history = getDb().collection<HistoryDoc>(HISTORY)
    // Se marca como deshecho ANTES de aplicar: dos toques seguidos no deshacen dos veces.
    const entry = await history.findOneAndUpdate(
      { id: historyId, companyId, undone: { $ne: true }, action: { $ne: 'undo' } },
      { $set: { undone: true } },
      { returnDocument: 'before' },
    )
    if (!entry) { res.status(409).json({ message: 'Este cambio ya se deshizo o no existe.' }); return }
    if (entry.scope && await isScopeClosed(companyId, entry.scope)) {
      await history.updateOne({ id: historyId }, { $set: { undone: false } })
      res.status(409).json({ message: 'Esta recepción está cerrada. Reábrela para deshacer.' }); return
    }

    const user = req.session?.user ?? 'desconocido'
    const inverse = entry.before - entry.after
    const entryRow = entry.rowKey ?? ''
    const { before, after } = await applyChange({
      companyId, scope: entry.scope ?? '', productCode: entry.productCode, rowKey: entryRow, delta: inverse, user,
    })
    await logHistory({
      companyId, scope: entry.scope ?? '', productCode: entry.productCode, productCodeLower: entry.productCodeLower, rowKey: entryRow,
      before, after, user, at: new Date().toISOString(), action: 'undo', undoOf: historyId,
    })
    res.json({ message: 'Cambio deshecho.', received: { productCode: entry.productCode, scope: entry.scope ?? '', rowKey: entryRow, quantity: after } })
  } catch (err) {
    console.error('[received] Error al deshacer:', err)
    res.status(500).json({ message: 'Error al deshacer el cambio.' })
  }
})

/**
 * DELETE /api/received/:productCode?companyId=xxx[&scope=yyy]
 * Desmarca un producto en una recepción.
 */
receivedRouter.delete('/:productCode', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.body?.companyId || req.session?.companyId
  const scope = scopeOf(req.query.scope ?? req.body?.scope)
  const productCode = (req.params.productCode ?? '').trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!productCode) { res.status(400).json({ message: 'productCode es requerido.' }); return }
  try {
    await ensureIndex()
    const user = req.session?.user ?? 'desconocido'
    const rowKey = rowKeyOf(req.query.rowKey ?? req.body?.rowKey)
    const { before, after } = await applyChange({ companyId, scope, productCode, rowKey, setQty: 0, user })
    if (before !== after) {
      await logHistory({
        companyId, scope, productCode, productCodeLower: productCode.toLowerCase(), rowKey,
        before, after, user, at: new Date().toISOString(), action: 'unmark',
      })
    }
    res.json({ message: 'Producto desmarcado.' })
  } catch (err) {
    console.error('[received] Error al desmarcar:', err)
    res.status(500).json({ message: 'Error al desmarcar el producto.' })
  }
})

// ── Recepciones ───────────────────────────────────────────────────────────

/** GET /api/received/scopes?companyId=xxx → recepciones de la empresa (recientes primero). */
receivedRouter.get('/scopes', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const scopes = await getDb().collection(SCOPES)
      .find({ companyId }, { projection: { _id: 0, companyId: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray()
    res.json({ scopes })
  } catch (err) {
    console.error('[received] Error al listar recepciones:', err)
    res.status(500).json({ message: 'Error al leer las recepciones.' })
  }
})

/** POST /api/received/scopes  Body: { companyId?, name } → crea una recepción. */
receivedRouter.post('/scopes', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const name = String(req.body?.name ?? '').trim().slice(0, 80)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!name) { res.status(400).json({ message: 'El nombre de la recepción es requerido.' }); return }
  try {
    await ensureIndex()
    const scope = {
      id: `rec_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      name,
      createdAt: new Date().toISOString(),
      createdBy: req.session?.user ?? 'desconocido',
      closed: false,
    }
    await getDb().collection(SCOPES).insertOne({ companyId, ...scope })
    res.json({ message: 'Recepción creada.', scope })
  } catch (err) {
    console.error('[received] Error al crear recepción:', err)
    res.status(500).json({ message: 'Error al crear la recepción.' })
  }
})

/** PATCH /api/received/scopes/:id  Body: { companyId?, closed } → cierra/reabre una recepción. */
receivedRouter.patch('/scopes/:id', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const id = String(req.params.id ?? '').trim()
  if (!companyId || !id) { res.status(400).json({ message: 'companyId e id son requeridos.' }); return }
  try {
    const r = await getDb().collection(SCOPES).updateOne({ companyId, id }, { $set: { closed: req.body?.closed === true } })
    if (r.matchedCount === 0) { res.status(404).json({ message: 'Recepción no encontrada.' }); return }
    res.json({ message: req.body?.closed === true ? 'Recepción cerrada.' : 'Recepción reabierta.' })
  } catch (err) {
    console.error('[received] Error al actualizar recepción:', err)
    res.status(500).json({ message: 'Error al actualizar la recepción.' })
  }
})

// ── Códigos escaneados que no están en la DATA ────────────────────────────

/** POST /api/received/not-found  Body: { companyId?, code, sheetId?, scope? } → registra (o cuenta) un código. */
receivedRouter.post('/not-found', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const code = String(req.body?.code ?? '').trim().slice(0, 120)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!code) { res.status(400).json({ message: 'code es requerido.' }); return }
  try {
    await ensureIndex()
    const now = new Date().toISOString()
    await getDb().collection(NOT_FOUND).updateOne(
      { companyId, codeLower: code.toLowerCase() },
      {
        $set: {
          code, lastAt: now, lastBy: req.session?.user ?? 'desconocido',
          ...(req.body?.sheetId ? { sheetId: String(req.body.sheetId) } : {}),
          scope: scopeOf(req.body?.scope),
        },
        $setOnInsert: { firstAt: now },
        $inc: { count: 1 },
      },
      { upsert: true },
    )
    res.json({ message: 'Código registrado como no encontrado.' })
  } catch (err) {
    console.error('[received] Error al registrar no encontrado:', err)
    res.status(500).json({ message: 'Error al registrar el código.' })
  }
})

/** GET /api/received/not-found?companyId=xxx → códigos no encontrados (recientes primero). */
receivedRouter.get('/not-found', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const items = await getDb().collection(NOT_FOUND)
      .find({ companyId }, { projection: { _id: 0, companyId: 0, codeLower: 0 } })
      .sort({ lastAt: -1 })
      .limit(200)
      .toArray()
    res.json({ notFound: items })
  } catch (err) {
    console.error('[received] Error al listar no encontrados:', err)
    res.status(500).json({ message: 'Error al leer los códigos no encontrados.' })
  }
})

/** DELETE /api/received/not-found/:code?companyId=xxx → quita un código de la lista. */
receivedRouter.delete('/not-found/:code', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  const code = String(req.params.code ?? '').trim()
  if (!companyId || !code) { res.status(400).json({ message: 'companyId y code son requeridos.' }); return }
  try {
    await getDb().collection(NOT_FOUND).deleteOne({ companyId, codeLower: code.toLowerCase() })
    res.json({ message: 'Código quitado de la lista.' })
  } catch (err) {
    console.error('[received] Error al quitar no encontrado:', err)
    res.status(500).json({ message: 'Error al quitar el código.' })
  }
})
