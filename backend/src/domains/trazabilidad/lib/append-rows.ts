/**
 * Agregar las filas de un documento a una tabla EXISTENTE.
 *
 *  - Las columnas se emparejan por NOMBRE (sin importar mayúsculas, tildes ni
 *    espacios): "Código" del documento cae en "CODIGO" de la tabla.
 *  - Las columnas del documento que la tabla no tiene se agregan al final (o
 *    se descartan, si se pide).
 *  - Opcional: no agregar filas cuyo código ya existe en la tabla (ni repetidas
 *    dentro del mismo documento).
 * Función pura, sin base de datos, para probarla.
 */

export interface AppendOptions {
  /** Columna de código EN LA TABLA DESTINO (para detectar repetidos). −1 = no revisar. */
  codeColumn?: number
  /** true = no agrega filas cuyo código ya está en la tabla. */
  skipDuplicates?: boolean
  /** true = agrega al final las columnas que la tabla no tiene. */
  addNewColumns?: boolean
}

export interface AppendResult {
  headers: string[]
  rows: string[][]
  added: number
  skippedDuplicates: number
  skippedEmpty: number
  newColumns: string[]
  /** Columnas del documento que no se usaron (cuando addNewColumns = false). */
  ignoredColumns: string[]
}

/** Clave de comparación de un encabezado o código. */
export function normKey(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

export function appendRows(
  targetHeaders: string[],
  targetRows: string[][],
  srcHeaders: string[],
  srcRows: string[][],
  opts: AppendOptions = {},
): AppendResult {
  const headers = [...targetHeaders]
  const byName = new Map<string, number>()
  headers.forEach((h, i) => { const k = normKey(h); if (k && !byName.has(k)) byName.set(k, i) })

  // Para cada columna del documento: a qué columna de la tabla va (−1 = se descarta).
  const newColumns: string[] = []
  const ignoredColumns: string[] = []
  const map = srcHeaders.map((h, i) => {
    const k = normKey(h)
    const found = k ? byName.get(k) : undefined
    if (found !== undefined) return found
    const name = String(h ?? '').trim() || `Columna ${i + 1}`
    if (opts.addNewColumns === false) { ignoredColumns.push(name); return -1 }
    headers.push(name)
    const idx = headers.length - 1
    if (k) byName.set(k, idx)
    newColumns.push(name)
    return idx
  })

  const width = headers.length
  const pad = (r: string[]) => (r.length >= width ? r : [...r, ...new Array(width - r.length).fill('')])
  const rows = targetRows.map((r) => pad(r.map((c) => String(c ?? ''))))

  const codeCol = typeof opts.codeColumn === 'number' && opts.codeColumn >= 0 && opts.codeColumn < width ? opts.codeColumn : -1
  const seen = new Set<string>()
  if (opts.skipDuplicates && codeCol >= 0) {
    for (const r of rows) { const k = normKey(r[codeCol]); if (k) seen.add(k) }
  }

  let added = 0
  let skippedDuplicates = 0
  let skippedEmpty = 0
  for (const src of srcRows) {
    const out = new Array<string>(width).fill('')
    map.forEach((to, from) => { if (to >= 0) out[to] = String(src?.[from] ?? '').trim() })
    if (out.every((c) => !c)) { skippedEmpty++; continue }
    if (opts.skipDuplicates && codeCol >= 0) {
      const k = normKey(out[codeCol])
      if (k && seen.has(k)) { skippedDuplicates++; continue }
      if (k) seen.add(k)
    }
    rows.push(out)
    added++
  }
  return { headers, rows, added, skippedDuplicates, skippedEmpty, newColumns, ignoredColumns }
}
