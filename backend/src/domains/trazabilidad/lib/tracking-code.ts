import { getOperationsCollection } from './mongodb.js'

/**
 * Genera un código de tracking único con formato: OP-YYYYMMDD-NNN
 * Donde NNN es un consecutivo del día.
 */
export async function generateTrackingCode(): Promise<string> {
  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]!.replace(/-/g, '')
  const prefix = `OP-${dateStr}`

  const col = getOperationsCollection()

  // Busca el último código del día
  const lastOp = await col
    .find({ trackingCode: { $regex: `^${prefix}` } })
    .sort({ trackingCode: -1 })
    .limit(1)
    .toArray()

  let sequence = 1
  if (lastOp.length > 0) {
    const lastCode = lastOp[0].trackingCode as string
    const lastSeq = parseInt(lastCode.split('-')[2] ?? '0', 10)
    sequence = lastSeq + 1
  }

  return `${prefix}-${String(sequence).padStart(3, '0')}`
}
