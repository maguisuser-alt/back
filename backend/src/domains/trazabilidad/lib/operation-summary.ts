/**
 * Datos del registro que acompañan el envío completo (WhatsApp y correo):
 * origen → destino (o lugar), detalle, operador, fecha/hora y totales. Es lo
 * mismo que muestra el resumen del registro en la app.
 */

export interface SummaryLocation { type?: string; name?: string; placa?: string }

export interface SummaryOp {
  operationType?: string
  vehiclePlate?: string
  operatorName?: string
  locationName?: string
  isTransfer?: boolean
  origin?: SummaryLocation | null
  destination?: SummaryLocation | null
  photos?: Array<{ driveUrl?: string; mediaType?: string }>
  lineaBlanca?: Array<{ photos?: Array<{ driveUrl?: string; mediaType?: string }> }>
}

export interface SummaryItem { label: string; value: string }

function locName(l?: SummaryLocation | null): string {
  if (!l) return ''
  const name = String(l.name ?? l.placa ?? '').trim()
  if (!name) return ''
  return l.type === 'vehiculo' ? `🚚 ${name}` : name
}

const isPhoto = (p: { driveUrl?: string; mediaType?: string }) =>
  Boolean(p.driveUrl && /^https?:\/\//.test(p.driveUrl)) && (!p.mediaType || p.mediaType === 'image')

/** Origen y destino. Sin origen, el destino se muestra como "Lugar" (como en la app). */
export function routeItems(op: SummaryOp): SummaryItem[] {
  const origen = locName(op.origin)
  const destino = locName(op.destination) || String(op.locationName ?? '').trim()
  if (origen && destino) return [{ label: 'Origen', value: origen }, { label: 'Destino', value: destino }]
  if (origen) return [{ label: 'Origen', value: origen }]
  if (destino) return [{ label: 'Lugar', value: destino }]
  return []
}

/** Total de fotos (generales + de productos) y de productos. */
export function totals(op: SummaryOp): { photos: number; products: number } {
  const general = (op.photos ?? []).filter(isPhoto).length
  const products = op.lineaBlanca ?? []
  const prodPhotos = products.reduce((s, p) => s + (p.photos ?? []).filter(isPhoto).length, 0)
  return { photos: general + prodPhotos, products: products.length }
}

/** Línea de WhatsApp: "📍 Origen: X → Destino: Y" o "📍 Lugar: Y". */
export function routeLine(op: SummaryOp): string {
  const items = routeItems(op)
  if (items.length === 0) return ''
  return `📍 ${items.map((i) => `${i.label}: ${i.value}`).join(' → ')}`
}

/** Línea de WhatsApp con los totales: "📷 9 foto(s) · 📦 1 producto(s)". */
export function totalsLine(op: SummaryOp): string {
  const t = totals(op)
  return `📷 ${t.photos} foto(s) · 📦 ${t.products} producto(s)`
}
