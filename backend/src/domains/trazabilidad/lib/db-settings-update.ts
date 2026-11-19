/**
 * Ajustes de la Base de datos (DATA) por compañía: tabla principal + columnas
 * por tabla. Funciones puras (sin Mongo) para poder probarlas.
 */

/** Configuración de columnas de una tabla (sheet). */
export type SheetColumnSettings = {
  codeColumn: number
  descColumn: number
  extraColumns: number[]
  /** Columna con la cantidad ESPERADA del producto (−1 = ninguna). */
  expectedColumn: number
}

/** Ajustes de la DATA de la empresa: tabla principal + columnas por tabla. */
export type DbSettings = {
  primarySheetId?: string
  primarySheetName?: string
  columns: Record<string, SheetColumnSettings>
}

/** Id de tabla usable como ruta de campo en Mongo (sin '.' ni '$' inicial). */
const SAFE_SHEET_ID = /^[^.$][^.]{0,119}$/

/** Normaliza/valida los ajustes de DATA recibidos del cliente o leídos de Mongo. */
export function sanitizeDbSettings(raw: unknown): DbSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const columnsIn = (obj.columns && typeof obj.columns === 'object' ? obj.columns : {}) as Record<string, unknown>
  const columns: Record<string, SheetColumnSettings> = {}
  for (const [sheetId, v] of Object.entries(columnsIn)) {
    const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const code = Number(c.codeColumn)
    const desc = Number(c.descColumn)
    const extra = Array.isArray(c.extraColumns) ? c.extraColumns.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : []
    const expected = c.expectedColumn === undefined || c.expectedColumn === null ? -1 : Number(c.expectedColumn)
    columns[sheetId] = {
      codeColumn: Number.isFinite(code) && code >= 0 ? code : 0,
      descColumn: Number.isFinite(desc) ? desc : -1,
      extraColumns: extra,
      expectedColumn: Number.isFinite(expected) && expected >= 0 ? expected : -1,
    }
  }
  return {
    primarySheetId: typeof obj.primarySheetId === 'string' ? obj.primarySheetId : undefined,
    primarySheetName: typeof obj.primarySheetName === 'string' ? obj.primarySheetName : undefined,
    columns,
  }
}

/**
 * Traduce el cuerpo del PUT a una actualización que COMBINA con lo guardado:
 * una entrada `dbSettings.columns.<id>` por tabla recibida y la tabla principal
 * solo si se pidió cambiarla (`primary: { id, name }`; `id: null` la quita).
 * Las tablas que no vienen en el cuerpo no se tocan.
 */
export function buildDbSettingsUpdate(body: Record<string, unknown>): { $set: Record<string, unknown>; $unset: Record<string, ''> } {
  const clean = sanitizeDbSettings(body)
  const $set: Record<string, unknown> = {}
  const $unset: Record<string, ''> = {}
  for (const [sheetId, cols] of Object.entries(clean.columns)) {
    if (SAFE_SHEET_ID.test(sheetId)) $set[`dbSettings.columns.${sheetId}`] = cols
  }
  const primary = body.primary
  if (primary && typeof primary === 'object') {
    const p = primary as { id?: unknown; name?: unknown }
    if (typeof p.id === 'string' && p.id.trim()) {
      $set['dbSettings.primarySheetId'] = p.id.trim()
      $set['dbSettings.primarySheetName'] = typeof p.name === 'string' ? p.name : ''
    } else {
      $unset['dbSettings.primarySheetId'] = ''
      $unset['dbSettings.primarySheetName'] = ''
    }
  } else if (typeof body.primarySheetId === 'string' && body.primarySheetId.trim()) {
    // Clientes anteriores (PWA en caché): envían la principal suelta.
    $set['dbSettings.primarySheetId'] = body.primarySheetId.trim()
    $set['dbSettings.primarySheetName'] = typeof body.primarySheetName === 'string' ? body.primarySheetName : ''
  }
  return { $set, $unset }
}
