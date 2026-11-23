/**
 * Marcas de recibido INDEPENDIENTES por tabla.
 *
 * Antes, un código único se marcaba con rowKey '' (marca "del código"), y esa
 * marca aparecía en TODAS las tablas que tuvieran el mismo código. Ahora la
 * marca siempre lleva la tabla: rowKey = sheetId (código único en la tabla) o
 * `${sheetId}:${n}` (n.ª fila de un código repetido).
 */

const MAX_ROWKEY = 120

/** rowKey efectivo: el de la fila, o la tabla si no hay fila concreta. */
export function sheetScopedRowKey(rowKey: string, sheetId: string | undefined): string {
  const rk = (rowKey ?? '').trim()
  if (rk) return rk.slice(0, MAX_ROWKEY)
  const s = String(sheetId ?? '').trim()
  return s ? s.slice(0, MAX_ROWKEY) : ''
}

/**
 * Tabla a la que pertenece una marca antigua (rowKey ''): la tabla guardada en
 * la marca; si no, la del último cambio del historial; si no, la DATA principal.
 * '' = no se puede saber (se deja como estaba).
 */
export function legacyTargetSheet(docSheetId?: string, historySheetId?: string, defaultSheetId?: string): string {
  for (const v of [docSheetId, historySheetId, defaultSheetId]) {
    const s = String(v ?? '').trim()
    if (s) return s.slice(0, MAX_ROWKEY)
  }
  return ''
}
