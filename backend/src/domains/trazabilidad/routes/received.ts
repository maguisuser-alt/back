/**
 * received.ts — Productos marcados como RECIBIDOS, compartidos por EMPRESA.
 *
 * Cuando un empleado marca un producto como recibido, la marca se guarda en
 * MongoDB con clave (companyId, productCode). Como todos los empleados de la
 * empresa consultan el mismo servidor, TODOS ven la marca en vivo (no es un
 * estado local del dispositivo de quien la puso).
 *
 * La marca es por CÓDIGO de producto a nivel de empresa: si el código llegó
 * (se recibió), queda marcado para toda la empresa, independientemente de la
 * operación/registro donde se marcó.
 *
 * Colección: `received_products`
 *   { companyId, productCode, productCodeLower, receivedBy, receivedAt, trackingCode? }
 * Índice único por (companyId, productCodeLower) para que marcar sea idempotente.
 */
import { Router } from 'express'
import { getDb } from '../lib/mongodb.js'

export const receivedRouter = Router()

const COLLECTION = 'received_products'

/** Asegura el índice único (companyId, productCodeLower) una sola vez. */
let indexEnsured = false
async function ensureIndex() {
  if (indexEnsured) return
  try {
    await getDb().collection(COLLECTION).createIndex(
      { companyId: 1, productCodeLower: 1 },
      { unique: true, name: 'company_product_unique' },
    )
    indexEnsured = true
  } catch {
    /* si falla, los upserts siguen funcionando; se reintenta al próximo request */
  }
}

interface ReceivedDoc {
  companyId: string
  productCode: string
  productCodeLower: string
  receivedBy: string
  receivedAt: string
  trackingCode?: string
  /** Unidades marcadas del producto (compartidas por la empresa). */
  quantity?: number
  /** Tabla DATA desde la que se marcó (informativo). */
  sheetId?: string
}

/** Cantidad efectiva: los marcados antiguos (sin campo) valen 1. */
function qtyOf(doc: Record<string, unknown> | null | undefined): number {
  const n = Number(doc?.quantity)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

/**
 * GET /api/received?companyId=xxx
 * Lista los productos recibidos de la empresa. El frontend la consulta (y la
 * refresca con el polling) para mostrar la marca a TODOS los empleados.
 * Respuesta: { received: [{ productCode, receivedBy, receivedAt, trackingCode }] }
 */
receivedRouter.get('/', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.session?.companyId
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await ensureIndex()
    const docs = await getDb().collection(COLLECTION)
      .find({ companyId }, { projection: { _id: 0, productCodeLower: 0, companyId: 0 } })
      .toArray()
    res.json({ received: docs.map((d) => ({ ...d, quantity: qtyOf(d) })) })
  } catch (err) {
    console.error('[received] Error al listar:', err)
    res.status(500).json({ message: 'Error al leer los productos recibidos.' })
  }
})

/**
 * POST /api/received
 * Body: { companyId?, productCode, trackingCode?, sheetId?, delta?, quantity? }
 * Marca un producto como recibido para toda la empresa, con su CANTIDAD.
 *  - delta (p. ej. +1 / -1): suma/resta unidades de forma atómica (varios
 *    empleados marcando a la vez no pisan la cuenta). Si llega a 0, se desmarca.
 *  - quantity: fija la cantidad exacta (0 = desmarcar).
 *  - sin delta ni quantity: marca con 1 si no estaba (compatibilidad).
 * companyId y el usuario salen de la sesión si no vienen en el body.
 */
receivedRouter.post('/', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const productCodeRaw = (req.body?.productCode as string) ?? ''
  const trackingCode = (req.body?.trackingCode as string) || undefined
  const sheetId = (req.body?.sheetId as string) || undefined
  const productCode = productCodeRaw.trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!productCode) { res.status(400).json({ message: 'productCode es requerido.' }); return }

  const rawDelta = req.body?.delta
  const rawQty = req.body?.quantity
  const delta = rawDelta === undefined || rawDelta === null ? null : Math.trunc(Number(rawDelta))
  const setQty = rawQty === undefined || rawQty === null ? null : Math.trunc(Number(rawQty))
  if ((delta !== null && !Number.isFinite(delta)) || (setQty !== null && (!Number.isFinite(setQty) || setQty < 0))) {
    res.status(400).json({ message: 'delta/quantity deben ser números válidos.' }); return
  }

  const key = { companyId, productCodeLower: productCode.toLowerCase() }
  const meta = {
    companyId,
    productCode,
    productCodeLower: key.productCodeLower,
    receivedBy: req.session?.user ?? 'desconocido',
    receivedAt: new Date().toISOString(),
    ...(trackingCode ? { trackingCode } : {}),
    ...(sheetId ? { sheetId } : {}),
  }

  try {
    await ensureIndex()
    const col = getDb().collection(COLLECTION)
    let quantity: number

    if (setQty !== null) {
      quantity = setQty
      if (quantity > 0) await col.updateOne(key, { $set: { ...meta, quantity } }, { upsert: true })
    } else if (delta !== null && delta !== 0) {
      // Los marcados antiguos no tienen `quantity` (valían 1): se normalizan
      // antes de sumar para que $inc parta de 1 y no de 0.
      await col.updateOne({ ...key, quantity: { $exists: false } }, { $set: { quantity: 1 } })
      const after = await col.findOneAndUpdate(
        key,
        { $inc: { quantity: delta }, $set: meta },
        { upsert: true, returnDocument: 'after' },
      )
      quantity = Number((after as { quantity?: number } | null)?.quantity ?? delta)
    } else {
      await col.updateOne(key, { $set: meta, $setOnInsert: { quantity: 1 } }, { upsert: true })
      quantity = qtyOf(await col.findOne(key, { projection: { quantity: 1 } }))
    }

    // 0 o menos → ya no está marcado.
    if (quantity <= 0) {
      await col.deleteOne(key)
      res.json({ message: 'Producto desmarcado.', removed: true, received: { productCode, quantity: 0 } })
      return
    }

    const doc: ReceivedDoc = { ...meta, quantity }
    res.json({
      message: 'Producto marcado como recibido.',
      received: {
        productCode: doc.productCode,
        receivedBy: doc.receivedBy,
        receivedAt: doc.receivedAt,
        trackingCode: doc.trackingCode,
        sheetId: doc.sheetId,
        quantity,
      },
    })
  } catch (err) {
    console.error('[received] Error al marcar:', err)
    res.status(500).json({ message: 'Error al marcar el producto como recibido.' })
  }
})

/**
 * DELETE /api/received/:productCode?companyId=xxx
 * Desmarca un producto (lo quita de recibidos) para toda la empresa.
 */
receivedRouter.delete('/:productCode', async (req, res) => {
  const companyId = (req.query.companyId as string) || req.body?.companyId || req.session?.companyId
  const productCode = (req.params.productCode ?? '').trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!productCode) { res.status(400).json({ message: 'productCode es requerido.' }); return }
  try {
    await getDb().collection(COLLECTION).deleteOne({
      companyId,
      productCodeLower: productCode.toLowerCase(),
    })
    res.json({ message: 'Producto desmarcado.' })
  } catch (err) {
    console.error('[received] Error al desmarcar:', err)
    res.status(500).json({ message: 'Error al desmarcar el producto.' })
  }
})
