/**
 * Rutas para la función "Documentos a Google Sheets".
 *
 * Flujo:
 *  - POST /api/sheets        → parsea el documento (CSV/XLSX/PDF), crea un
 *                              Google Sheet en la carpeta de Drive de la empresa
 *                              vía Apps Script y guarda la referencia en Mongo.
 *  - GET  /api/sheets        → lista las sheets creadas por una empresa.
 *  - POST /api/sheets/preview→ solo parsea el documento y devuelve la tabla
 *                              (para previsualizar antes de crear la hoja).
 *  - DELETE /api/sheets/:id  → elimina la Sheet de Drive y la referencia en Mongo.
 */

import { Router } from 'express'
import { nanoid } from 'nanoid'
import { getDb } from '../lib/mongodb.js'
import { parseDocument } from '../lib/document-parser.js'
import { callGas } from '../lib/gas.js'

export const sheetsRouter = Router()

const COLLECTION = 'company_sheets'
const SETTINGS_COLLECTION = 'company_settings'

interface SheetDoc {
  id: string
  companyId: string
  sheetName: string
  /** Presentes solo si la tabla se exportó a Google Sheets. */
  sheetId?: string
  sheetUrl?: string
  sourceFileName: string
  columns: string[]
  rowCount: number
  /** Filas importadas, para poder verificar los datos desde la app. */
  rows: string[][]
  /** true si las filas se recortaron por exceder el límite de almacenamiento. */
  rowsTruncated: boolean
  createdAt: string
}

/**
 * Máximo de filas que persistimos en Mongo para verificación dentro de la app.
 * La hoja de Google Sheets siempre tiene TODAS las filas; este límite solo
 * aplica a la copia que se guarda para visualizar en la app (evita documentos
 * demasiado grandes). 
 */
const MAX_STORED_ROWS = 5000

/** Obtiene el folderId de Drive configurado para una empresa. */
async function getCompanyFolderId(companyId: string): Promise<string> {
  try {
    const settings = await getDb().collection(SETTINGS_COLLECTION).findOne({ companyId })
    if (settings?.driveFolderId) return settings.driveFolderId as string
  } catch { /* db not ready */ }
  return process.env.DRIVE_FOLDER_ID ?? ''
}

/** Verifica que la función esté habilitada para la empresa. */
async function isSheetsEnabled(companyId: string): Promise<boolean> {
  try {
    const settings = await getDb().collection(SETTINGS_COLLECTION).findOne({ companyId })
    return settings?.sheetsEnabled === true
  } catch {
    // Si MongoDB no está disponible no bloqueamos: la fuente de datos real de
    // esta función es Google Sheets vía Apps Script. Fail-open para no impedir
    // importar/crear tablas por una caída temporal de la base de metadatos.
    return true
  }
}

/**
 * POST /api/sheets/preview
 * Body: { fileName, mimeType, base64 }
 * Devuelve { headers, rows } sin crear nada.
 */
sheetsRouter.post('/preview', async (req, res) => {
  const { fileName, mimeType, base64 } = req.body ?? {}
  if (!base64 || !fileName) {
    res.status(400).json({ message: 'fileName y base64 son requeridos.' }); return
  }
  try {
    const table = await parseDocument(base64, fileName, mimeType)
    if (table.headers.length === 0 && table.rows.length === 0) {
      res.status(422).json({ message: 'No se encontró ninguna tabla en el documento.' }); return
    }
    res.json({ headers: table.headers, rows: table.rows })
  } catch (err) {
    res.status(422).json({ message: err instanceof Error ? err.message : 'No se pudo leer el documento.' })
  }
})

/**
 * POST /api/sheets/import
 * Body: { companyId, fileName, mimeType, base64, sheetName? }
 * Importa la tabla SOLO a la app (la guarda en Mongo) para poder mirar y usar
 * los datos dentro de la aplicación, sin crear ninguna Google Sheet ni requerir
 * la configuración de Google Drive / Apps Script.
 */
sheetsRouter.post('/import', async (req, res) => {
  const { companyId, fileName, mimeType, base64, sheetName } = req.body ?? {}

  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!base64 || !fileName) { res.status(400).json({ message: 'fileName y base64 son requeridos.' }); return }

  if (!(await isSheetsEnabled(companyId))) {
    res.status(403).json({ message: 'La función de Documentos no está habilitada para esta empresa.' }); return
  }

  try {
    const table = await parseDocument(base64, fileName, mimeType)
    if (table.headers.length === 0 && table.rows.length === 0) {
      res.status(422).json({ message: 'No se encontró ninguna tabla en el documento.' }); return
    }

    const finalName = (sheetName?.trim() || fileName.replace(/\.[^.]+$/, '')).slice(0, 100)
    const storedRows = table.rows.slice(0, MAX_STORED_ROWS)
    const doc: SheetDoc = {
      id: nanoid(10),
      companyId: companyId.trim(),
      sheetName: finalName,
      // Sin sheetId/sheetUrl → tabla que vive solo en la app
      sourceFileName: fileName,
      columns: table.headers,
      rowCount: table.rows.length,
      rows: storedRows,
      rowsTruncated: table.rows.length > MAX_STORED_ROWS,
      createdAt: new Date().toISOString(),
    }
    await getDb().collection(COLLECTION).insertOne(doc)

    const { rows: _omit, ...sheetMeta } = doc
    res.json({ message: 'Tabla importada a la app correctamente.', sheet: sheetMeta, preview: { headers: table.headers, rows: table.rows } })
  } catch (err) {
    console.error('[sheets] Error al importar:', err)
    res.status(500).json({ message: err instanceof Error ? err.message : 'Error al importar la tabla.' })
  }
})

/**
 * POST /api/sheets
 * Body: { companyId, fileName, mimeType, base64, sheetName? }
 * Parsea el documento, crea el Sheet en Drive y guarda la referencia.
 */
sheetsRouter.post('/', async (req, res) => {
  const { companyId, fileName, mimeType, base64, sheetName } = req.body ?? {}

  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!base64 || !fileName) { res.status(400).json({ message: 'fileName y base64 son requeridos.' }); return }

  if (!(await isSheetsEnabled(companyId))) {
    res.status(403).json({ message: 'La función de Documentos a Sheets no está habilitada para esta empresa.' }); return
  }

  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
  if (!GAS_URL) {
    res.status(502).json({ message: 'GAS_WEBHOOK_URL no configurado. Ve a Configuración para conectar Google Drive.' }); return
  }

  try {
    // 1. Parsear el documento a tabla
    const table = await parseDocument(base64, fileName, mimeType)
    if (table.headers.length === 0 && table.rows.length === 0) {
      res.status(422).json({ message: 'No se encontró ninguna tabla en el documento.' }); return
    }

    // 2. Crear el Sheet vía Apps Script
    const finalName = (sheetName?.trim() || fileName.replace(/\.[^.]+$/, '')).slice(0, 100)
    const parentFolderId = await getCompanyFolderId(companyId)

    let gasData: { status?: string; sheetId?: string; sheetUrl?: string; rowCount?: number; columnCount?: number; message?: string }
    try {
      gasData = await callGas(GAS_URL, {
        action: 'createSheet',
        sheetName: finalName,
        headers: table.headers,
        rows: table.rows,
        parentFolderId: parentFolderId || undefined,
      })
    } catch (gasErr) {
      res.status(502).json({ message: gasErr instanceof Error ? gasErr.message : 'Error al contactar Google Apps Script.' }); return
    }

    if (gasData.status !== 'success' || !gasData.sheetId) {
      res.status(502).json({ message: gasData.message ?? 'No se pudo crear la hoja en Google Sheets.' }); return
    }

    // 3. Guardar referencia + filas en Mongo (para verificar desde la app)
    const storedRows = table.rows.slice(0, MAX_STORED_ROWS)
    const doc: SheetDoc = {
      id: nanoid(10),
      companyId: companyId.trim(),
      sheetName: finalName,
      sheetId: gasData.sheetId,
      sheetUrl: gasData.sheetUrl ?? `https://docs.google.com/spreadsheets/d/${gasData.sheetId}/edit`,
      sourceFileName: fileName,
      columns: table.headers,
      rowCount: table.rows.length,
      rows: storedRows,
      rowsTruncated: table.rows.length > MAX_STORED_ROWS,
      createdAt: new Date().toISOString(),
    }
    // Guardar la referencia en Mongo es "best-effort": la hoja ya existe en
    // Google Sheets (fuente de datos). Si Mongo no está disponible, no se
    // pierde la tabla; simplemente no quedará en el listado de metadatos.
    let persisted = true
    try {
      await getDb().collection(COLLECTION).insertOne(doc)
    } catch (dbErr) {
      persisted = false
      console.warn('[sheets] Hoja creada en Sheets pero no se guardó la referencia en Mongo:', dbErr instanceof Error ? dbErr.message : dbErr)
    }

    // No devolver las filas completas en la metadata del listado
    const { rows: _omit, ...sheetMeta } = doc
    res.json({
      message: persisted
        ? 'Hoja creada correctamente.'
        : 'Hoja creada en Google Sheets (la referencia local no se guardó).',
      sheet: sheetMeta,
      preview: { headers: table.headers, rows: table.rows },
    })
  } catch (err) {
    console.error('[sheets] Error al crear:', err)
    res.status(500).json({ message: err instanceof Error ? err.message : 'Error al crear la hoja.' })
  }
})

/**
 * GET /api/sheets?companyId=xxx
 * Lista las sheets creadas por una empresa (más recientes primero).
 */
sheetsRouter.get('/', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const docs = await getDb().collection(COLLECTION)
      // Excluir 'rows' del listado (puede ser grande); se cargan bajo demanda en GET /:id
      .find({ companyId }, { projection: { _id: 0, rows: 0 } })
      .sort({ createdAt: -1 })
      .toArray()
    res.json({ sheets: docs })
  } catch (err) {
    console.error('[sheets] Error al listar:', err)
    res.status(500).json({ message: 'Error al listar las hojas.' })
  }
})

/**
 * GET /api/sheets/:id?companyId=xxx[&source=sheet]
 * Devuelve los datos completos de una tabla importada (headers + rows).
 * Si source=sheet y la tabla tiene sheetId, lee los datos EN VIVO desde la
 * Google Sheet vía Apps Script (fuente de verdad = Google Sheets); si falla,
 * cae a la copia guardada en Mongo.
 */
sheetsRouter.get('/:id', async (req, res) => {
  const { id } = req.params
  const { companyId, source } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne(
      { id, companyId },
      { projection: { _id: 0 } },
    )
    if (!doc) { res.status(404).json({ message: 'Hoja no encontrada.' }); return }

    // Lectura en vivo desde Google Sheets vía Apps Script
    const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
    if (source === 'sheet' && doc.sheetId && GAS_URL) {
      try {
        const live = await callGas(GAS_URL, { action: 'getSheetData', sheetId: doc.sheetId, maxRows: MAX_STORED_ROWS }, 60_000) as {
          status?: string; headers?: string[]; rows?: string[][]; rowCount?: number; rowsTruncated?: boolean; sheetUrl?: string
        }
        if (live.status === 'success') {
          res.json({
            id: doc.id,
            sheetName: doc.sheetName,
            sheetUrl: live.sheetUrl ?? doc.sheetUrl,
            sourceFileName: doc.sourceFileName,
            headers: live.headers ?? (doc.columns ?? []),
            rows: live.rows ?? [],
            rowCount: live.rowCount ?? (live.rows?.length ?? 0),
            rowsTruncated: live.rowsTruncated === true,
            source: 'sheet',
            createdAt: doc.createdAt,
          })
          return
        }
      } catch (e) {
        console.warn('[sheets] Lectura en vivo falló, usando copia local:', e)
      }
    }

    // Copia guardada en Mongo
    res.json({
      id: doc.id,
      sheetName: doc.sheetName,
      sheetUrl: doc.sheetUrl,
      sourceFileName: doc.sourceFileName,
      headers: doc.columns ?? [],
      rows: (doc.rows as string[][]) ?? [],
      rowCount: doc.rowCount ?? 0,
      rowsTruncated: doc.rowsTruncated === true,
      source: 'stored',
      createdAt: doc.createdAt,
    })
  } catch (err) {
    console.error('[sheets] Error al leer hoja:', err)
    res.status(500).json({ message: 'Error al leer la hoja.' })
  }
})

/**
 * GET /api/sheets/:id/lookup?companyId=xxx&code=ABC&codeColumn=0[&descColumn=2][&source=sheet]
 * Busca una fila por su código dentro de la tabla fijada (DATA) y devuelve los
 * datos del producto. Se usa cuando un registro tiene una base de datos fija:
 * al ingresar/escanear un código, trae automáticamente la descripción y la fila.
 *
 * - codeColumn: índice de la columna que contiene el código (default 0).
 * - descColumn: índice de la columna de descripción (opcional).
 * - La comparación es exacta pero case-insensitive y sin espacios extremos.
 */
sheetsRouter.get('/:id/lookup', async (req, res) => {
  const { id } = req.params
  const { companyId, code, codeColumn, descColumn, source } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  const needle = (code ?? '').trim().toLowerCase()
  if (!needle) { res.status(400).json({ message: 'code es requerido.' }); return }

  const codeCol = Number.isFinite(Number(codeColumn)) ? Math.max(0, Math.trunc(Number(codeColumn))) : 0
  const descCol = descColumn !== undefined && descColumn !== '' && Number.isFinite(Number(descColumn))
    ? Math.trunc(Number(descColumn))
    : -1

  try {
    const doc = await getDb().collection(COLLECTION).findOne({ id, companyId }, { projection: { _id: 0 } })
    if (!doc) { res.status(404).json({ message: 'Base de datos no encontrada.' }); return }

    let headers: string[] = (doc.columns as string[]) ?? []
    let rows: string[][] = (doc.rows as string[][]) ?? []

    // Lectura en vivo desde Google Sheets si se pide y hay sheetId.
    const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
    if (source === 'sheet' && doc.sheetId && GAS_URL) {
      try {
        const live = await callGas(GAS_URL, { action: 'getSheetData', sheetId: doc.sheetId, maxRows: MAX_STORED_ROWS }, 60_000) as {
          status?: string; headers?: string[]; rows?: string[][]
        }
        if (live.status === 'success') {
          headers = live.headers ?? headers
          rows = live.rows ?? rows
        }
      } catch { /* cae a copia local */ }
    }

    const match = rows.find((r) => String(r[codeCol] ?? '').trim().toLowerCase() === needle)
    if (!match) {
      res.json({ found: false, headers, sheetName: doc.sheetName })
      return
    }

    const descripcion = descCol >= 0 ? String(match[descCol] ?? '').trim() : ''
    // Mapa columna→valor para poder mostrar todos los datos de la fila.
    const data: Record<string, string> = {}
    headers.forEach((h, i) => { data[h || `col${i}`] = String(match[i] ?? '') })

    res.json({
      found: true,
      sheetName: doc.sheetName,
      headers,
      row: match,
      code: String(match[codeCol] ?? ''),
      descripcion,
      data,
    })
  } catch (err) {
    console.error('[sheets] Error en lookup:', err)
    res.status(500).json({ message: 'Error al buscar en la base de datos.' })
  }
})

/**
 * GET /api/sheets/:id/search?companyId=xxx&q=texto[&codeColumn=0][&descColumn=2][&limit=20][&source=sheet]
 * Busca por CÓDIGO o NOMBRE/DESCRIPCIÓN (coincidencia parcial, case-insensitive)
 * dentro de la tabla fijada y devuelve TODOS los resultados (hasta `limit`).
 *
 * Orden de relevancia: coincidencia exacta del código → el código empieza por q
 * → coincidencia parcial en código o descripción.
 *
 * Respuesta: { results: [{ rowIndex, code, descripcion, row, data }], total, headers }
 */
sheetsRouter.get('/:id/search', async (req, res) => {
  const { id } = req.params
  const { companyId, q, codeColumn, descColumn, limit, source } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  const needle = (q ?? '').trim().toLowerCase()
  if (!needle) { res.status(400).json({ message: 'q es requerido.' }); return }

  const codeCol = Number.isFinite(Number(codeColumn)) ? Math.max(0, Math.trunc(Number(codeColumn))) : 0
  const descCol = descColumn !== undefined && descColumn !== '' && Number.isFinite(Number(descColumn))
    ? Math.trunc(Number(descColumn))
    : -1
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(100, Math.trunc(Number(limit))) : 20

  try {
    const doc = await getDb().collection(COLLECTION).findOne({ id, companyId }, { projection: { _id: 0 } })
    if (!doc) { res.status(404).json({ message: 'Base de datos no encontrada.' }); return }

    let headers: string[] = (doc.columns as string[]) ?? []
    let rows: string[][] = (doc.rows as string[][]) ?? []

    const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
    if (source === 'sheet' && doc.sheetId && GAS_URL) {
      try {
        const live = await callGas(GAS_URL, { action: 'getSheetData', sheetId: doc.sheetId, maxRows: MAX_STORED_ROWS }, 60_000) as {
          status?: string; headers?: string[]; rows?: string[][]
        }
        if (live.status === 'success') {
          headers = live.headers ?? headers
          rows = live.rows ?? rows
        }
      } catch { /* cae a copia local */ }
    }

    // Puntúa cada fila: menor score = más relevante.
    const scored: Array<{ rowIndex: number; score: number; row: string[] }> = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const codeVal = String(row[codeCol] ?? '').trim().toLowerCase()
      const descVal = descCol >= 0 ? String(row[descCol] ?? '').trim().toLowerCase() : ''
      let score = Infinity
      if (codeVal === needle) score = 0
      else if (codeVal.startsWith(needle)) score = 1
      else if (codeVal.includes(needle)) score = 2
      else if (descVal.includes(needle)) score = 3
      // Búsqueda amplia: también busca en cualquier celda (última prioridad).
      else if (row.some((c) => String(c ?? '').toLowerCase().includes(needle))) score = 4
      if (score !== Infinity) scored.push({ rowIndex: i, score, row })
    }

    scored.sort((a, b) => a.score - b.score || a.rowIndex - b.rowIndex)
    const total = scored.length
    const top = scored.slice(0, max)

    const results = top.map(({ rowIndex, row }) => {
      const data: Record<string, string> = {}
      headers.forEach((h, idx) => { data[h || `col${idx}`] = String(row[idx] ?? '') })
      return {
        rowIndex,
        code: String(row[codeCol] ?? '').trim(),
        descripcion: descCol >= 0 ? String(row[descCol] ?? '').trim() : '',
        row,
        data,
      }
    })

    res.json({ results, total, headers, sheetName: doc.sheetName })
  } catch (err) {
    console.error('[sheets] Error en search:', err)
    res.status(500).json({ message: 'Error al buscar en la base de datos.' })
  }
})

/**
 * PUT /api/sheets/:id/rows
 * Body: { companyId, rows, headers? }
 * Guarda las filas editadas en Mongo y actualiza la Google Sheet (best-effort).
 */
sheetsRouter.put('/:id/rows', async (req, res) => {
  const { id } = req.params
  const { companyId, rows, headers } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!Array.isArray(rows)) { res.status(400).json({ message: 'rows debe ser un arreglo.' }); return }

  try {
    const col = getDb().collection(COLLECTION)
    const doc = await col.findOne({ id, companyId: companyId.trim() })
    if (!doc) { res.status(404).json({ message: 'Hoja no encontrada.' }); return }

    // Normalizar: todas las celdas a string
    const cleanRows: string[][] = (rows as unknown[][]).map((r) =>
      (Array.isArray(r) ? r : []).map((c) => (c === null || c === undefined ? '' : String(c))),
    )
    const stored = cleanRows.slice(0, MAX_STORED_ROWS)
    const finalHeaders = Array.isArray(headers) && headers.length > 0
      ? (headers as string[]).map((h) => String(h))
      : (doc.columns as string[]) ?? []

    // 1. Guardar en Mongo
    await col.updateOne(
      { id, companyId: companyId.trim() },
      {
        $set: {
          rows: stored,
          rowCount: cleanRows.length,
          rowsTruncated: cleanRows.length > MAX_STORED_ROWS,
          columns: finalHeaders,
          updatedAt: new Date().toISOString(),
        },
      },
    )

    // 2. Actualizar la Google Sheet (best-effort — no bloquea el guardado)
    let sheetUpdated = false
    const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
    if (GAS_URL && doc.sheetId) {
      try {
        const data = await callGas(GAS_URL, { action: 'updateSheet', sheetId: doc.sheetId, headers: finalHeaders, rows: stored })
        sheetUpdated = data.status === 'success'
      } catch (e) {
        console.warn('[sheets] No se pudo actualizar la Google Sheet:', e)
      }
    }

    const hasSheet = Boolean(doc.sheetId)
    res.json({
      message: !hasSheet
        ? 'Cambios guardados en la app.'
        : sheetUpdated
          ? 'Cambios guardados y sincronizados con Google Sheets.'
          : 'Cambios guardados en la app. No se pudo sincronizar con Google Sheets.',
      rowCount: cleanRows.length,
      sheetUpdated,
    })
  } catch (err) {
    console.error('[sheets] Error al guardar filas:', err)
    res.status(500).json({ message: 'Error al guardar los cambios.' })
  }
})

/**
 * DELETE /api/sheets/:id
 * Body/query: { companyId }
 * Elimina la Sheet de Drive (papelera) y borra la referencia en Mongo.
 */
sheetsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params
  const companyId = (req.body?.companyId ?? req.query.companyId) as string | undefined
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }

  try {
    const col = getDb().collection(COLLECTION)
    const doc = await col.findOne({ id, companyId: companyId.trim() })
    if (!doc) { res.status(404).json({ message: 'Hoja no encontrada.' }); return }

    // Eliminar de Drive vía Apps Script (best-effort)
    const GAS_URL = process.env.GAS_WEBHOOK_URL ?? ''
    if (GAS_URL && doc.sheetId) {
      try {
        await callGas(GAS_URL, { action: 'deleteFile', fileId: doc.sheetId }, 30_000)
      } catch (e) {
        console.warn('[sheets] No se pudo eliminar de Drive:', e)
      }
    }

    await col.deleteOne({ id, companyId: companyId.trim() })
    res.json({ message: 'Hoja eliminada.' })
  } catch (err) {
    console.error('[sheets] Error al eliminar:', err)
    res.status(500).json({ message: 'Error al eliminar la hoja.' })
  }
})
