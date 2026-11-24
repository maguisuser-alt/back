/**
 * Datos de la fila de la DATA que se muestran en "Actividad reciente" cuando se
 * marca un producto: las columnas elegidas en "Columnas" de esa tabla
 * (descripción + columnas adicionales). Funciones puras.
 */

export interface SheetColumnsConfig {
  codeColumn?: number
  descColumn?: number
  extraColumns?: number[]
}

export interface MarkField { label: string; value: string }

const MAX_FIELDS = 6
const MAX_VALUE = 80

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

/**
 * Fila de la marca: `rowKey` = sheetId (código único en la tabla) o
 * `${sheetId}:${n}` (n.ª fila con ese código). Sin número → primera fila con el código.
 */
export function findMarkedRow(rows: string[][], codeCol: number, productCode: string, rowKey?: string): string[] | null {
  if (codeCol < 0) return null
  const code = norm(productCode)
  if (!code) return null
  const m = /:(\d+)$/.exec(String(rowKey ?? ''))
  const n = m ? Number(m[1]) : 1
  let seen = 0
  for (const r of rows) {
    if (norm(r?.[codeCol]) !== code) continue
    seen++
    if (seen === n) return r
  }
  return null
}

/** Columnas elegidas (descripción primero, luego las adicionales) con su valor. */
export function selectedFields(row: string[], headers: string[], cols: SheetColumnsConfig): MarkField[] {
  const code = typeof cols.codeColumn === 'number' ? cols.codeColumn : 0
  const order: number[] = []
  const add = (i: unknown) => {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i === code || order.includes(i)) return
    order.push(i)
  }
  add(cols.descColumn)
  for (const i of cols.extraColumns ?? []) add(i)
  const out: MarkField[] = []
  for (const i of order) {
    const value = String(row[i] ?? '').trim()
    if (!value) continue
    out.push({ label: String(headers[i] ?? '').trim() || `Columna ${i + 1}`, value: value.slice(0, MAX_VALUE) })
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

/**
 * Descripción guardada en el producto del registro ("Desc · Cliente: Ana") como
 * campos, para cuando la fila ya no está en la tabla.
 */
export function fieldsFromDescription(desc: string | undefined): MarkField[] {
  const parts = String(desc ?? '').split(' · ').map((p) => p.trim()).filter(Boolean)
  return parts.slice(0, MAX_FIELDS).map((p, i) => {
    const k = p.indexOf(': ')
    if (k > 0) return { label: p.slice(0, k), value: p.slice(k + 2).slice(0, MAX_VALUE) }
    return { label: i === 0 ? 'Descripción' : '', value: p.slice(0, MAX_VALUE) }
  })
}
