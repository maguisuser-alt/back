/**
 * Parser de documentos tabulares.
 * Convierte CSV / XLSX / PDF (con tablas basadas en texto) a { headers, rows }.
 *
 * - CSV / XLSX: usa SheetJS (xlsx), robusto.
 * - PDF: usa pdfjs-dist extrayendo texto con posición (x,y) y agrupando
 *   los items en filas por coordenada Y y en columnas por coordenada X.
 *   Funciona bien con PDFs de texto (no escaneados). Para PDFs escaneados
 *   (imágenes) no hay texto que extraer y se devuelve un error claro.
 */

import * as XLSX from 'xlsx'

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

export type DocumentKind = 'csv' | 'xlsx' | 'pdf'

/** Detecta el tipo de documento a partir del nombre y/o mimeType. */
export function detectKind(fileName: string, mimeType?: string): DocumentKind | null {
  const name = (fileName || '').toLowerCase()
  const mime = (mimeType || '').toLowerCase()

  if (name.endsWith('.csv') || mime.includes('csv')) return 'csv'
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel')) return 'xlsx'
  if (name.endsWith('.pdf') || mime.includes('pdf')) return 'pdf'
  return null
}

/** Normaliza una matriz de filas crudas (con posibles longitudes dispares) a ParsedTable. */
function toTable(matrix: unknown[][]): ParsedTable {
  // Eliminar filas totalmente vacías
  const cleaned = matrix
    .map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)).trim()))
    .filter((r) => r.some((c) => c !== ''))

  if (cleaned.length === 0) return { headers: [], rows: [] }

  const headers = cleaned[0]
  const rows = cleaned.slice(1)

  // Igualar longitud de columnas a la del header
  const width = Math.max(headers.length, ...rows.map((r) => r.length))
  const pad = (r: string[]) => {
    const out = r.slice(0, width)
    while (out.length < width) out.push('')
    return out
  }

  return {
    headers: pad(headers),
    rows: rows.map(pad),
  }
}

/** Parsea CSV o XLSX desde un buffer usando SheetJS. */
function parseSpreadsheet(buffer: Buffer): ParsedTable {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) return { headers: [], rows: [] }
  const sheet = wb.Sheets[firstSheetName]
  // header:1 → matriz de arrays (fila por fila)
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' })
  return toTable(matrix)
}

interface PdfTextItem {
  str: string
  x: number
  y: number
}

/**
 * Parsea un PDF de texto a tabla.
 * Estrategia: extraer todos los items con coordenadas, agruparlos por fila
 * (misma Y aproximada) y luego inferir columnas por posición X usando los
 * saltos de la primera fila como separadores aproximados.
 */
async function parsePdf(buffer: Buffer): Promise<ParsedTable> {
  // Import dinámico del build legacy (compatible con Node/ESM sin worker DOM).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const uint8 = new Uint8Array(buffer)
  const loadingTask = pdfjs.getDocument({ data: uint8, useSystemFonts: true })
  const pdf = await loadingTask.promise

  const allRows: PdfTextItem[][] = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()

    const items: PdfTextItem[] = []
    for (const item of content.items) {
      // TextItem tiene .str y .transform [a,b,c,d,e,f] donde e=x, f=y
      const anyItem = item as { str?: string; transform?: number[] }
      if (!anyItem.str || !anyItem.transform) continue
      const text = anyItem.str.trim()
      if (!text) continue
      items.push({ str: text, x: anyItem.transform[4], y: anyItem.transform[5] })
    }

    // Agrupar por fila: misma Y (con tolerancia). PDF Y crece hacia arriba.
    const Y_TOL = 3
    items.sort((a, b) => b.y - a.y || a.x - b.x)

    const rows: PdfTextItem[][] = []
    for (const it of items) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last[0].y - it.y) <= Y_TOL) {
        last.push(it)
      } else {
        rows.push([it])
      }
    }
    for (const r of rows) {
      r.sort((a, b) => a.x - b.x)
      allRows.push(r)
    }
  }

  if (allRows.length === 0) {
    throw new Error('El PDF no contiene texto extraíble. Si es un documento escaneado (imagen), expórtalo a CSV o Excel.')
  }

  // Inferir columnas: usar las posiciones X de la fila con MÁS celdas como plantilla.
  const templateRow = allRows.reduce((best, r) => (r.length > best.length ? r : best), allRows[0])
  const colStarts = templateRow.map((c) => c.x)

  // Asignar cada item a la columna cuyo inicio X esté más cerca (sin pasarse mucho).
  const assignColumn = (x: number): number => {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < colStarts.length; i++) {
      const d = Math.abs(colStarts[i] - x)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    return bestIdx
  }

  const numCols = colStarts.length
  const matrix: string[][] = allRows.map((row) => {
    const cells = new Array<string>(numCols).fill('')
    for (const it of row) {
      const col = assignColumn(it.x)
      cells[col] = cells[col] ? `${cells[col]} ${it.str}` : it.str
    }
    return cells
  })

  return toTable(matrix)
}

/**
 * Punto de entrada: parsea un documento (base64) a tabla.
 */
export async function parseDocument(
  base64: string,
  fileName: string,
  mimeType?: string,
): Promise<ParsedTable> {
  const kind = detectKind(fileName, mimeType)
  if (!kind) {
    throw new Error('Formato no soportado. Usa un archivo CSV, Excel (.xlsx) o PDF.')
  }

  // El base64 puede venir con prefijo data URL — lo quitamos.
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const buffer = Buffer.from(clean, 'base64')

  if (kind === 'csv' || kind === 'xlsx') {
    return parseSpreadsheet(buffer)
  }
  return parsePdf(buffer)
}
