/**
 * "Actividad reciente" de la empresa: une en una sola lista, de lo más nuevo a
 * lo más viejo,
 *  - los REGISTROS (operaciones): creado, actualizado (productos/fotos), completado;
 *  - las marcas en la DATA (received_history): qué producto, cuántas piezas,
 *    en qué tabla y recepción, y quién;
 *  - las actividades anotadas a mano (activity_log).
 * Funciones puras: reciben los documentos ya leídos de Mongo (para probarlas).
 */

export type FeedKind = 'registro' | 'data' | 'manual'

export interface FeedItem {
  id: string
  kind: FeedKind
  /** Qué pasó, en corto (p. ej. "Registro completado"). */
  title: string
  /** Detalle legible (producto, piezas, tipo de registro…). */
  detail: string
  /** Fecha ISO del evento. */
  at: string
  user?: string
  /** Registro relacionado (para abrirlo). */
  trackingCode?: string
  /** true si el registro sigue en proceso (se puede abrir para continuar). */
  open?: boolean
  /** DATA usada. */
  sheetId?: string
  sheetName?: string
  /** Recepción en la que se marcó ('' = General). */
  scopeName?: string
}

export interface OpDoc {
  trackingCode?: string
  operationType?: string
  operatorName?: string
  vehiclePlate?: string
  locationName?: string
  status?: string
  createdAt?: string
  updatedAt?: string
  completedAt?: string
  productos?: number
  fotos?: number
  lastProduct?: string
}

export interface HistDoc {
  id?: string
  productCode?: string
  before?: number
  after?: number
  user?: string
  at?: string
  action?: string
  trackingCode?: string
  sheetId?: string
  scope?: string
}

export interface LogDoc {
  _id?: unknown
  action?: string
  detail?: string
  createdAt?: string
  meta?: { trackingCode?: string; operatorName?: string } & Record<string, unknown>
}

/** Nombre legible del tipo de registro ("PRODUCTOS_ENTRANTES" → "Productos entrantes"). */
export function opTypeLabel(t: string | undefined): string {
  if (!t) return 'Registro'
  const s = t.replace(/_/g, ' ').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const valid = (iso: unknown): iso is string => typeof iso === 'string' && !Number.isNaN(Date.parse(iso))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Eventos de un registro: creado, actualizado (si cambió después) y completado. */
export function operationEvents(op: OpDoc): FeedItem[] {
  if (!op.trackingCode) return []
  const code = op.trackingCode
  const type = opTypeLabel(op.operationType)
  const who = op.operatorName || undefined
  const extras = [op.vehiclePlate, op.locationName].filter(Boolean).join(' · ')
  const counts = `${plural(op.productos ?? 0, 'producto', 'productos')} · ${plural(op.fotos ?? 0, 'foto', 'fotos')}`
  const open = op.status !== 'COMPLETADO'
  const out: FeedItem[] = []
  if (valid(op.createdAt)) {
    out.push({
      id: `op-new-${code}`, kind: 'registro', title: 'Registro creado',
      detail: [type, extras].filter(Boolean).join(' · '), at: op.createdAt, user: who, trackingCode: code, open,
    })
  }
  if (!open && valid(op.completedAt)) {
    out.push({
      id: `op-done-${code}`, kind: 'registro', title: 'Registro completado',
      detail: `${type} · ${counts}`, at: op.completedAt, user: who, trackingCode: code, open: false,
    })
  } else if (valid(op.updatedAt) && valid(op.createdAt) && Date.parse(op.updatedAt) - Date.parse(op.createdAt) > 60_000) {
    out.push({
      id: `op-upd-${code}`, kind: 'registro', title: 'Registro actualizado',
      detail: `${type} · ${counts}${op.lastProduct ? ` · último: ${op.lastProduct}` : ''}`,
      at: op.updatedAt, user: who, trackingCode: code, open,
    })
  }
  return out
}

/** Evento de una marca en la DATA. */
export function markEvent(h: HistDoc, names: { sheets: Map<string, string>; scopes: Map<string, string> }): FeedItem | null {
  if (!valid(h.at) || !h.productCode) return null
  const before = Number(h.before) || 0
  const after = Number(h.after) || 0
  const title = h.action === 'undo' ? 'Cambio deshecho en DATA'
    : after <= 0 ? 'Desmarcado en DATA'
    : before > 0 ? 'Piezas actualizadas en DATA'
    : 'Marcado en DATA'
  const detail = after > 0 ? `${h.productCode} · ${plural(after, 'pieza', 'piezas')}` : h.productCode
  return {
    id: `mark-${h.id ?? `${h.productCode}-${h.at}`}`,
    kind: 'data',
    title,
    detail,
    at: h.at,
    user: h.user || undefined,
    trackingCode: h.trackingCode || undefined,
    sheetId: h.sheetId || undefined,
    sheetName: h.sheetId ? names.sheets.get(h.sheetId) : undefined,
    scopeName: h.scope ? (names.scopes.get(h.scope) ?? undefined) : undefined,
  }
}

/** Evento de una actividad anotada a mano. */
export function logEvent(l: LogDoc): FeedItem | null {
  if (!valid(l.createdAt) || !l.detail) return null
  return {
    id: `log-${String(l._id ?? l.createdAt)}`,
    kind: 'manual',
    title: 'Actividad anotada',
    detail: l.detail,
    at: l.createdAt,
    user: l.meta?.operatorName || undefined,
    trackingCode: l.meta?.trackingCode || undefined,
  }
}

/** Une todo, de lo más nuevo a lo más viejo, y corta en `limit`. */
export function buildActivityFeed(input: {
  ops: OpDoc[]
  history: HistDoc[]
  logs: LogDoc[]
  sheets: Map<string, string>
  scopes: Map<string, string>
  limit: number
}): FeedItem[] {
  const items: FeedItem[] = [
    ...input.ops.flatMap(operationEvents),
    ...input.history.map((h) => markEvent(h, input)).filter((x): x is FeedItem => x !== null),
    ...input.logs.map(logEvent).filter((x): x is FeedItem => x !== null),
  ]
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return items.slice(0, Math.max(1, input.limit))
}
