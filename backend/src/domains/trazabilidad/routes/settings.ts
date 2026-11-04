import { Router } from 'express'
import { getDb, getOperationsCollection, getMovementsCollection } from '../lib/mongodb.js'
import {
  FEATURE_KEYS, DEFAULT_OPERATION_TYPES_LIMIT, TURNOS_API_URL,
  readAllowed, type FeatureKey,
} from '../lib/features.js'

export const settingsRouter = Router()

const COLLECTION = 'company_settings'

function resetWhatsAppUnifiedCache() {
  import('./whatsapp-web.js').then((m) => m.resetUnifiedCache?.()).catch(() => { /* noop */ })
}

/**
 * Extrae el folderId desde una URL de Google Drive.
 * Soporta formatos:
 * - https://drive.google.com/drive/folders/FOLDER_ID
 * - https://drive.google.com/drive/u/0/folders/FOLDER_ID
 * - Solo el ID directamente
 */
function parseDriveFolderUrl(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (match?.[1]) return match[1]
  // Si no tiene "/" es probablemente el ID directo
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed
  return trimmed
}

/**
 * GET /api/settings?companyId=xxx
 * Obtiene la configuración de Drive para una empresa.
 */
settingsRouter.get('/', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) {
    res.status(400).json({ message: 'companyId es requerido.' })
    return
  }
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId })
    res.json({
      driveFolderUrl: doc?.driveFolderUrl ?? '',
      driveFolderId: doc?.driveFolderId ?? '',
    })
  } catch (err) {
    console.error('[settings] Error al leer:', err)
    res.status(500).json({ message: 'Error al leer configuración.' })
  }
})

/**
 * PUT /api/settings
 * Guarda la URL de la carpeta de Drive para una empresa.
 * Body: { companyId, driveFolderUrl }
 */
settingsRouter.put('/', async (req, res) => {
  const { companyId, driveFolderUrl } = req.body ?? {}

  if (!companyId?.trim()) {
    res.status(400).json({ message: 'companyId es requerido.' })
    return
  }

  const folderUrl = driveFolderUrl?.trim() ?? ''
  const folderId = parseDriveFolderUrl(folderUrl)

  try {
    const db = getDb()
    await db.collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      {
        $set: {
          companyId: companyId.trim(),
          driveFolderUrl: folderUrl,
          driveFolderId: folderId,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    )
    res.json({ message: 'Carpeta de Drive guardada.', driveFolderUrl: folderUrl, driveFolderId: folderId })
  } catch (err) {
    console.error('[settings] Error al guardar:', err)
    res.status(500).json({ message: 'Error al guardar configuración.' })
  }
})

/**
 * GET /api/settings/plates?companyId=xxx
 * Obtiene las placas guardadas de una empresa.
 */
settingsRouter.get('/plates', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId })
    res.json({ plates: (doc?.plates as string[]) ?? [] })
  } catch (err) {
    console.error('[settings] Error al leer placas:', err)
    res.status(500).json({ message: 'Error al leer placas.' })
  }
})

/**
 * POST /api/settings/plates
 * Agrega una placa a la empresa. Body: { companyId, plate }
 */
settingsRouter.post('/plates', async (req, res) => {
  const { companyId, plate } = req.body ?? {}
  if (!companyId?.trim() || !plate?.trim()) {
    res.status(400).json({ message: 'companyId y plate son requeridos.' })
    return
  }
  const cleanPlate = plate.trim().toUpperCase()
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId: companyId.trim() })
    const current = (doc?.plates as string[]) ?? []
    const updated = [cleanPlate, ...current.filter((p) => p !== cleanPlate)].slice(0, 50)
    await db.collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { companyId: companyId.trim(), plates: updated, updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    res.json({ plates: updated })
  } catch (err) {
    console.error('[settings] Error al guardar placa:', err)
    res.status(500).json({ message: 'Error al guardar placa.' })
  }
})

/**
 * DELETE /api/settings/plates
 * Elimina una placa. Body: { companyId, plate }
 */
settingsRouter.delete('/plates', async (req, res) => {
  const { companyId, plate } = req.body ?? {}
  if (!companyId?.trim() || !plate?.trim()) {
    res.status(400).json({ message: 'companyId y plate son requeridos.' })
    return
  }
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId: companyId.trim() })
    const current = (doc?.plates as string[]) ?? []
    const updated = current.filter((p) => p !== plate.trim().toUpperCase())
    await db.collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { plates: updated, updatedAt: new Date().toISOString() } },
    )
    res.json({ plates: updated })
  } catch (err) {
    console.error('[settings] Error al eliminar placa:', err)
    res.status(500).json({ message: 'Error al eliminar placa.' })
  }
})

// ── Lugares / ubicaciones ───────────────────────────────────────────────
/** Lugar donde se realiza una operación. */
type CompanyLocation = { id: string; name: string; address?: string; city?: string }

/** Genera un id estable y corto para un lugar. */
function makeLocationId(): string {
  return `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Normaliza y valida la lista de lugares (nombre requerido, sin duplicados por nombre). */
function sanitizeLocations(raw: unknown): CompanyLocation[] {
  const list = Array.isArray(raw) ? (raw as Array<Partial<CompanyLocation>>) : []
  const seen = new Set<string>()
  const clean: CompanyLocation[] = []
  for (const l of list) {
    const name = String(l?.name ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const id = (l?.id && String(l.id).trim()) ? String(l.id).trim() : makeLocationId()
    clean.push({
      id,
      name,
      address: String(l?.address ?? '').trim() || undefined,
      city: String(l?.city ?? '').trim() || undefined,
    })
  }
  return clean
}

/**
 * GET /api/settings/locations?companyId=xxx
 * Devuelve los lugares configurados de la empresa.
 */
settingsRouter.get('/locations', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const locations = Array.isArray(doc?.locations) ? sanitizeLocations(doc!.locations) : []
    res.json({ locations })
  } catch (err) {
    console.error('[settings] Error al leer lugares:', err)
    res.status(500).json({ message: 'Error al leer los lugares.' })
  }
})

/**
 * PUT /api/settings/locations
 * Body: { companyId, locations: Array<{ id?, name, address?, city? }> }
 * Guarda la lista COMPLETA de lugares de la empresa.
 */
settingsRouter.put('/locations', async (req, res) => {
  const { companyId, locations } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!Array.isArray(locations)) { res.status(400).json({ message: 'locations debe ser un arreglo.' }); return }
  const clean = sanitizeLocations(locations)
  try {
    await getDb().collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { companyId: companyId.trim(), locations: clean, updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    res.json({ message: 'Lugares guardados.', locations: clean })
  } catch (err) {
    console.error('[settings] Error al guardar lugares:', err)
    res.status(500).json({ message: 'Error al guardar los lugares.' })
  }
})

/**
 * Devuelve los productos cuya UBICACIÓN ACTUAL (último movimiento) coincide con el
 * filtro de destino dado. Se resuelve en dos pasos: último movimiento por producto
 * y luego filtro por el destino. Así un producto solo aparece en su ubicación
 * actual, no en las anteriores.
 */
async function productsAtLocation(companyId: string, matchTo: Record<string, unknown>) {
  const movCol = getMovementsCollection()
  const rows = await movCol.aggregate([
    { $match: { companyId } },
    { $sort: { at: -1 } },
    { $group: { _id: '$productCodeLower', productCode: { $first: '$productCode' }, to: { $first: '$to' }, since: { $first: '$at' } } },
    { $match: Object.fromEntries(Object.entries(matchTo).map(([k, v]) => [`to.${k}`, v])) },
    { $sort: { since: -1 } },
    { $limit: 500 },
  ]).toArray()
  return rows.map((r) => ({ productCode: r.productCode as string, since: r.since as string }))
}

/**
 * GET /api/settings/locations/:locationId/products?companyId=xxx
 * Productos cuya ubicación actual es el LUGAR indicado (Req 8.1).
 */
settingsRouter.get('/locations/:locationId/products', async (req, res) => {
  const { locationId } = req.params
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const products = await productsAtLocation(companyId, { type: 'lugar', id: locationId })
    res.json({ products })
  } catch (err) {
    console.error('[settings] Error al leer productos por lugar:', err)
    res.status(500).json({ message: 'Error al leer los productos del lugar.' })
  }
})

/**
 * GET /api/settings/locations/by-vehicle/:placa/products?companyId=xxx
 * Productos cuya ubicación actual es el VEHÍCULO con esa placa (Req 8.3).
 */
settingsRouter.get('/locations/by-vehicle/:placa/products', async (req, res) => {
  const { placa } = req.params
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  const normalized = String(placa).toUpperCase().replace(/[^A-Z0-9]/g, '')
  try {
    const products = await productsAtLocation(companyId, { type: 'vehiculo', placa: normalized })
    res.json({ products })
  } catch (err) {
    console.error('[settings] Error al leer productos por vehículo:', err)
    res.status(500).json({ message: 'Error al leer los productos del vehículo.' })
  }
})

// ── Ajustes de Base de datos (DATA) por compañía ────────────────────────
/** Configuración de columnas de una tabla (sheet). */
type SheetColumnSettings = { codeColumn: number; descColumn: number; extraColumns: number[] }
/** Ajustes de la DATA de la empresa: tabla principal + columnas por tabla. */
type DbSettings = {
  primarySheetId?: string
  primarySheetName?: string
  columns: Record<string, SheetColumnSettings>
}

/** Normaliza/valida los ajustes de DATA recibidos del cliente. */
function sanitizeDbSettings(raw: unknown): DbSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const columnsIn = (obj.columns && typeof obj.columns === 'object' ? obj.columns : {}) as Record<string, unknown>
  const columns: Record<string, SheetColumnSettings> = {}
  for (const [sheetId, v] of Object.entries(columnsIn)) {
    const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const code = Number(c.codeColumn)
    const desc = Number(c.descColumn)
    const extra = Array.isArray(c.extraColumns) ? c.extraColumns.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : []
    columns[sheetId] = {
      codeColumn: Number.isFinite(code) && code >= 0 ? code : 0,
      descColumn: Number.isFinite(desc) ? desc : -1,
      extraColumns: extra,
    }
  }
  return {
    primarySheetId: typeof obj.primarySheetId === 'string' ? obj.primarySheetId : undefined,
    primarySheetName: typeof obj.primarySheetName === 'string' ? obj.primarySheetName : undefined,
    columns,
  }
}

/**
 * GET /api/settings/db?companyId=xxx
 * Devuelve los ajustes de la base de datos (tabla principal + columnas por tabla)
 * de la empresa.
 */
settingsRouter.get('/db', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const saved = doc?.dbSettings ? sanitizeDbSettings(doc.dbSettings) : { columns: {} }
    res.json(saved)
  } catch (err) {
    console.error('[settings] Error al leer dbSettings:', err)
    res.status(500).json({ message: 'Error al leer los ajustes de base de datos.' })
  }
})

/**
 * PUT /api/settings/db
 * Body: { companyId, primarySheetId?, primarySheetName?, columns: { [sheetId]: {...} } }
 * Guarda la configuración COMPLETA de la DATA de la empresa.
 */
settingsRouter.put('/db', async (req, res) => {
  const { companyId } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  const clean = sanitizeDbSettings(req.body)
  try {
    await getDb().collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { companyId: companyId.trim(), dbSettings: clean, updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    res.json({ message: 'Ajustes de base de datos guardados.', ...clean })
  } catch (err) {
    console.error('[settings] Error al guardar dbSettings:', err)
    res.status(500).json({ message: 'Error al guardar los ajustes de base de datos.' })
  }
})

/**
 * GET /api/settings/cleanup?companyId=xxx
 * Obtiene la configuración de limpieza automática de una empresa.
 */
settingsRouter.get('/cleanup', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId })
    res.json({
      cleanupEnabled: doc?.cleanupEnabled === true,
      cleanupDays: typeof doc?.cleanupDays === 'number' ? doc.cleanupDays : 20,
    })
  } catch (err) {
    console.error('[settings] Error al leer config cleanup:', err)
    res.status(500).json({ message: 'Error al leer configuración de limpieza.' })
  }
})

/**
 * PUT /api/settings/cleanup
 * Guarda la configuración de limpieza automática.
 * Body: { companyId, cleanupEnabled, cleanupDays }
 */
settingsRouter.put('/cleanup', async (req, res) => {
  const { companyId, cleanupEnabled, cleanupDays } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  // Normaliza cleanupDays: acepta número o string numérico enviado por el cliente.
  const rawDays = typeof cleanupDays === 'number' ? cleanupDays : Number(cleanupDays)
  const days = Number.isFinite(rawDays) && rawDays >= 1 ? Math.round(rawDays) : 20
  // Normaliza cleanupEnabled: acepta boolean o string "true"/"false".
  const enabled = cleanupEnabled === true || cleanupEnabled === 'true'
  try {
    const db = getDb()
    await db.collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      {
        $set: {
          companyId: companyId.trim(),
          cleanupEnabled: enabled,
          cleanupDays: days,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    )
    res.json({ message: 'Configuración de limpieza guardada.', cleanupEnabled: enabled, cleanupDays: days })
  } catch (err) {
    console.error('[settings] Error al guardar config cleanup:', err)
    res.status(500).json({ message: 'Error al guardar configuración de limpieza.' })
  }
})

/**
 * GET /api/settings/features?companyId=xxx
 * Devuelve los flags de funciones habilitadas para la empresa.
 */
settingsRouter.get('/features', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const db = getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const allowed = readAllowed(doc)
    // Valor EFECTIVO de una función: activa solo si (a) el ROOT la permitió y
    // (b) la empresa NO la desactivó explícitamente (`doc[k] === false`).
    // El root es la autoridad sobre QUÉ se permite; el admin de la empresa
    // decide, dentro de lo permitido, si la usa o no. Antes se devolvía solo
    // `allowed[k]`, así que al apagar una opción en Configuración el cambio se
    // guardaba pero el GET la reportaba activa de nuevo (no se reflejaba en el
    // registro). Incluir `doc[k]` hace que el guardado del admin surta efecto.
    const eff = (k: FeatureKey) => allowed[k] === true && doc?.[k] !== false
    const opLimit = typeof doc?.operationTypesLimit === 'number' ? doc.operationTypesLimit : DEFAULT_OPERATION_TYPES_LIMIT
    res.json({
      sheetsEnabled: eff('sheetsEnabled'),
      activityLog: eff('activityLog'),
      sendEmail: eff('sendEmail'),
      whatsappTrazabilidad: eff('whatsappTrazabilidad'),
      whatsappUnified: eff('whatsappUnified'),
      whatsappAudio: eff('whatsappAudio'),
      whatsappCatalog: eff('whatsappCatalog'),
      whatsappDocument: eff('whatsappDocument'),
      markerEditor: eff('markerEditor'),
      registrarActividad: eff('registrarActividad'),
      locationsEnabled: eff('locationsEnabled'),
      addProduct: eff('addProduct'),
      selectImage: eff('selectImage'),
      pasteImage: eff('pasteImage'),
      watermark: eff('watermark'),
      watermarkDate: eff('watermarkDate'),
      watermarkTime: eff('watermarkTime'),
      watermarkLocation: eff('watermarkLocation'),
      operationTypesLimit: opLimit,
      // `allowed`: qué funciones concedió el root (para que el panel del cliente
      // oculte/bloquee las no permitidas, incluso para el admin principal).
      allowed,
      // Estado EFECTIVO del vínculo con turnos: solo activo si el root lo
      // permitió (whatsappUnified) Y existe TURNOS_API_URL (Req 7.4, 7.5).
      integrations: { turnos: { linked: eff('whatsappUnified') && Boolean(TURNOS_API_URL) } },
    })
  } catch (err) {
    console.error('[settings] Error al leer features:', err)
    res.status(500).json({ message: 'Error al leer funciones.' })
  }
})

/**
 * PUT /api/settings/features
 * Habilita/deshabilita funciones para la empresa.
 * Body: { companyId, sheetsEnabled?, activityLog?, sendEmail?, whatsappUnified?, whatsappAudio?, whatsappCatalog?, whatsappDocument?, markerEditor?, registrarActividad? }
 */
settingsRouter.put('/features', async (req, res) => {
  const body = req.body ?? {}
  const companyId = (body.companyId as string)?.trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }

  // Origen de la petición:
  //  - 'root': proviene del panel super-admin. Define QUÉ se permite (allowedFeatures)
  //            además del valor; es la autoridad final.
  //  - admin de empresa (sin source): solo puede cambiar funciones PERMITIDAS por el root.
  const isRoot = body.source === 'root'

  try {
    const db = getDb()
    const existing = await db.collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const allowed = readAllowed(existing)

    const $set: Record<string, unknown> = { companyId, updatedAt: new Date().toISOString() }

    if (isRoot) {
      // El root permite una función cuando la enciende; la deniega cuando la apaga.
      const newAllowed = {} as Record<FeatureKey, boolean>
      for (const k of FEATURE_KEYS) {
        if (typeof body[k] === 'boolean') {
          $set[k] = body[k]
          newAllowed[k] = body[k] as boolean
        } else {
          newAllowed[k] = allowed[k]
        }
      }
      $set.allowedFeatures = newAllowed
      // El root también define el límite de tipos de operación personalizados.
      if (typeof body.operationTypesLimit === 'number' && body.operationTypesLimit >= 0) {
        $set.operationTypesLimit = Math.round(body.operationTypesLimit)
      }
      // El root también puede definir el correo destinatario inicial.
      if (typeof body.emailTo === 'string') {
        $set.emailTo = body.emailTo.trim()
      }
    } else {
      // Admin de empresa: ignora cualquier función NO permitida por el root.
      for (const k of FEATURE_KEYS) {
        if (typeof body[k] === 'boolean') {
          $set[k] = allowed[k] ? body[k] : false
        }
      }
    }

    await db.collection(COLLECTION).updateOne(
      { companyId },
      { $set },
      { upsert: true },
    )
    resetWhatsAppUnifiedCache()
    res.json({ message: 'Funciones actualizadas.', ...$set })
  } catch (err) {
    console.error('[settings] Error al guardar features:', err)
    res.status(500).json({ message: 'Error al guardar funciones.' })
  }
})

/**
 * GET /api/settings/email?companyId=xxx
 * Devuelve el correo destinatario al que se envían los registros.
 */
settingsRouter.get('/email', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId })
    res.json({ emailTo: (doc?.emailTo as string) ?? '' })
  } catch (err) {
    console.error('[settings] Error al leer email:', err)
    res.status(500).json({ message: 'Error al leer el correo destinatario.' })
  }
})

/**
 * PUT /api/settings/email
 * Body: { companyId, emailTo }  — correo(s) destinatario(s) separados por coma
 */
settingsRouter.put('/email', async (req, res) => {
  const { companyId, emailTo } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    await getDb().collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { companyId: companyId.trim(), emailTo: (emailTo ?? '').trim(), updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    res.json({ message: 'Correo destinatario guardado.', emailTo: (emailTo ?? '').trim() })
  } catch (err) {
    console.error('[settings] Error al guardar email:', err)
    res.status(500).json({ message: 'Error al guardar el correo destinatario.' })
  }
})

/** Destino de WhatsApp: etiqueta + número/JID. */
type WaDestination = { id: string; label: string; to: string }

/**
 * Normaliza la configuración de destinos a una lista, soportando datos viejos
 * (un solo `whatsappTo` string) y nuevos (`whatsappDestinations` array).
 */
function readDestinations(doc: Record<string, unknown> | null): WaDestination[] {
  const list = Array.isArray(doc?.whatsappDestinations) ? (doc!.whatsappDestinations as WaDestination[]) : []
  if (list.length > 0) {
    return list
      .filter((d) => d && typeof d.to === 'string' && d.to.trim())
      .map((d) => ({ id: String(d.id || d.to), label: String(d.label || d.to).trim(), to: String(d.to).trim() }))
  }
  // Compatibilidad: un único whatsappTo legacy.
  const legacy = (doc?.whatsappTo as string) ?? ''
  return legacy.trim() ? [{ id: legacy.trim(), label: legacy.trim(), to: legacy.trim() }] : []
}

/**
 * GET /api/settings/whatsapp?companyId=xxx
 * Devuelve la lista de destinos de WhatsApp y, por compatibilidad, el primero
 * como `whatsappTo` (string).
 */
settingsRouter.get('/whatsapp', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const destinations = readDestinations(doc)
    res.json({ destinations, whatsappTo: destinations[0]?.to ?? '' })
  } catch (err) {
    console.error('[settings] Error al leer whatsapp:', err)
    res.status(500).json({ message: 'Error al leer el destino de WhatsApp.' })
  }
})

/**
 * PUT /api/settings/whatsapp
 * Body (nuevo): { companyId, destinations: Array<{ id?, label, to }> }
 * Body (compat): { companyId, whatsappTo }  — un único destino
 */
settingsRouter.put('/whatsapp', async (req, res) => {
  const { companyId, destinations, whatsappTo } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    let list: WaDestination[]
    if (Array.isArray(destinations)) {
      list = (destinations as Array<Partial<WaDestination>>)
        .map((d) => ({ to: String(d.to ?? '').trim(), label: String(d.label ?? d.to ?? '').trim() }))
        .filter((d) => d.to)
        .map((d) => ({ id: d.to, label: d.label || d.to, to: d.to }))
    } else {
      // Compat: un solo whatsappTo
      const t = (whatsappTo ?? '').trim()
      list = t ? [{ id: t, label: t, to: t }] : []
    }
    await getDb().collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      {
        $set: {
          companyId: companyId.trim(),
          whatsappDestinations: list,
          whatsappTo: list[0]?.to ?? '', // mantiene compat para envíos sin selección
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    )
    res.json({ message: 'Destinos de WhatsApp guardados.', destinations: list, whatsappTo: list[0]?.to ?? '' })
  } catch (err) {
    console.error('[settings] Error al guardar whatsapp:', err)
    res.status(500).json({ message: 'Error al guardar el destino de WhatsApp.' })
  }
})

/** Tipo de operación configurable por la empresa. */
type OperationTypeDef = { id: string; label: string; descripcion?: string }

/**
 * Tipos de operación por defecto. Son solo un punto de partida (y la base de
 * "Restaurar por defecto"); la empresa puede editarlos o eliminarlos todos.
 * Ninguno es fijo.
 */
const DEFAULT_OPERATION_TYPES: OperationTypeDef[] = [
  { id: 'PRODUCTOS_ENTRANTES', label: 'Operación Entrante', descripcion: 'Registro de productos que ingresan al almacén o local.' },
  { id: 'PRODUCTOS_SALIENTES', label: 'Operación Saliente', descripcion: 'Registro de productos que salen para despacho o entrega.' },
  { id: 'ACTIVIDAD', label: 'Registro de actividad', descripcion: 'Registro fotográfico de una actividad.' },
]

/** Convierte una etiqueta libre en un id en MAYÚSCULAS_CON_GUIONES. */
function slugifyTypeId(label: string): string {
  return label
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || `TIPO_${Date.now()}`
}

function sanitizeTypes(raw: unknown): OperationTypeDef[] {
  const list = Array.isArray(raw) ? (raw as Array<Partial<OperationTypeDef>>) : []
  const seen = new Set<string>()
  const clean: OperationTypeDef[] = []
  for (const t of list) {
    const label = String(t?.label ?? '').trim()
    if (!label) continue
    const id = (t?.id && String(t.id).trim()) ? String(t.id).trim() : slugifyTypeId(label)
    if (seen.has(id)) continue
    seen.add(id)
    clean.push({ id, label, descripcion: String(t?.descripcion ?? '').trim() || undefined })
  }
  return clean
}

/**
 * GET /api/settings/operation-types?companyId=xxx
 * Devuelve la lista COMPLETA de tipos de la empresa. Todos los tipos son
 * editables y eliminables (ninguno es fijo). Si la empresa nunca los configuró,
 * se devuelven los por defecto como punto de partida.
 * `defaults` se incluye solo como referencia (para "restaurar por defecto").
 * `limit` es el máximo de tipos permitidos (0 = sin límite).
 */
settingsRouter.get('/operation-types', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const saved = Array.isArray(doc?.operationTypes) ? sanitizeTypes(doc!.operationTypes) : null
    const all = saved ?? DEFAULT_OPERATION_TYPES
    const limit = typeof doc?.operationTypesLimit === 'number' ? doc.operationTypesLimit : DEFAULT_OPERATION_TYPES_LIMIT
    res.json({ defaults: DEFAULT_OPERATION_TYPES, all, configured: saved !== null, limit })
  } catch (err) {
    console.error('[settings] Error al leer tipos de operación:', err)
    res.status(500).json({ message: 'Error al leer los tipos de operación.' })
  }
})

/**
 * PUT /api/settings/operation-types
 * Body: { companyId, types: Array<{ id?, label, descripcion? }> }
 * Guarda la lista COMPLETA de tipos que la empresa quiere. Todos los tipos son
 * editables y eliminables (ninguno es fijo). Debe quedar al menos un tipo y se
 * respeta el límite total configurado por el root (operationTypesLimit, 0 = sin
 * límite).
 */
settingsRouter.put('/operation-types', async (req, res) => {
  const { companyId, types } = req.body ?? {}
  if (!companyId?.trim()) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!Array.isArray(types)) { res.status(400).json({ message: 'types debe ser un arreglo.' }); return }

  const clean = sanitizeTypes(types)

  // Lee el límite configurado por el root (si existe).
  let opLimit = DEFAULT_OPERATION_TYPES_LIMIT
  try {
    const doc = await getDb().collection(COLLECTION).findOne({ companyId: companyId.trim() }) as Record<string, unknown> | null
    opLimit = typeof doc?.operationTypesLimit === 'number' ? doc.operationTypesLimit : DEFAULT_OPERATION_TYPES_LIMIT
  } catch { /* sin límite */ }

  // Aplica el límite total de tipos (0 = sin límite).
  if (opLimit > 0 && clean.length > opLimit) {
    res.status(400).json({ message: `No puedes tener más de ${opLimit} tipo(s) de operación.` })
    return
  }

  if (clean.length === 0) { res.status(400).json({ message: 'Debe quedar al menos un tipo de operación.' }); return }

  try {
    await getDb().collection(COLLECTION).updateOne(
      { companyId: companyId.trim() },
      { $set: { companyId: companyId.trim(), operationTypes: clean, updatedAt: new Date().toISOString() } },
      { upsert: true },
    )
    res.json({ message: 'Tipos de operación guardados.', all: clean, limit: opLimit })
  } catch (err) {
    console.error('[settings] Error al guardar tipos de operación:', err)
    res.status(500).json({ message: 'Error al guardar los tipos de operación.' })
  }
})
