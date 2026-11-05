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
    res.json({ received: docs })
  } catch (err) {
    console.error('[received] Error al listar:', err)
    res.status(500).json({ message: 'Error al leer los productos recibidos.' })
  }
})

/**
 * POST /api/received
 * Body: { companyId?, productCode, trackingCode? }
 * Marca un producto como recibido para toda la empresa (idempotente: si ya
 * estaba, actualiza quién/ cuándo). companyId y el usuario salen de la sesión.
 */
receivedRouter.post('/', async (req, res) => {
  const companyId = (req.body?.companyId as string) || req.session?.companyId
  const productCodeRaw = (req.body?.productCode as string) ?? ''
  const trackingCode = (req.body?.trackingCode as string) || undefined
  const productCode = productCodeRaw.trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!productCode) { res.status(400).json({ message: 'productCode es requerido.' }); return }

  const doc: ReceivedDoc = {
    companyId,
    productCode,
    productCodeLower: productCode.toLowerCase(),
    receivedBy: req.session?.user ?? 'desconocido',
    receivedAt: new Date().toISOString(),
    trackingCode,
  }

  try {
    await ensureIndex()
    await getDb().collection(COLLECTION).updateOne(
      { companyId, productCodeLower: doc.productCodeLower },
      { $set: doc },
      { upsert: true },
    )
    res.json({
      message: 'Producto marcado como recibido.',
      received: {
        productCode: doc.productCode,
        receivedBy: doc.receivedBy,
        receivedAt: doc.receivedAt,
        trackingCode: doc.trackingCode,
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
