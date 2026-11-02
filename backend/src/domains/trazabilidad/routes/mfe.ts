import { Router } from 'express'
import { getDb } from '../lib/mongodb.js'
import { readAllowed, readOperationTypesLimit, turnosLinked } from '../lib/features.js'

/**
 * Metadatos de este microfrontend para el Host (/root-panel).
 *
 * Expone el ESQUEMA de opciones de configuración reales de trazabilidad, para
 * que el portal las descubra dinámicamente (en vez de tenerlas hardcodeadas) y
 * las muestre por compañía. Es público (solo describe campos, no datos).
 */
export const mfeRouter = Router()

mfeRouter.get('/config-schema', (_req, res) => {
  res.json({
    name: 'Trazabilidad',
    version: 2,
    fields: [
      { key: 'watermark', label: 'Marca de agua en fotos', type: 'boolean', default: true, hint: 'Estampar fecha, hora y ubicación.' },
      { key: 'watermarkDate', label: 'Incluir fecha en la marca', type: 'boolean', default: true },
      { key: 'watermarkTime', label: 'Incluir hora en la marca', type: 'boolean', default: true },
      { key: 'watermarkLocation', label: 'Incluir ubicación en la marca', type: 'boolean', default: true },
      { key: 'sheetsEnabled', label: 'Base de datos (DATA)', type: 'boolean', default: false, hint: 'Permite importar y consultar tablas de productos.' },
      { key: 'activityLog', label: 'Registro de actividades', type: 'boolean', default: false },
      { key: 'registrarActividad', label: 'Registrar actividad manual', type: 'boolean', default: false },
      { key: 'sendEmail', label: 'Enviar registros por correo', type: 'boolean', default: false },
      { key: 'emailTo', label: 'Correo(s) destinatario(s)', type: 'text', default: '', hint: 'Separados por coma.' },
      { key: 'whatsappTrazabilidad', label: 'WhatsApp de Trazabilidad', type: 'boolean', default: false, hint: 'Cuenta propia de WhatsApp para enviar registros.' },
      { key: 'whatsappUnified', label: 'Vincular WhatsApp con Turnos', type: 'boolean', default: false, hint: 'Usa la cuenta de WhatsApp de Turnos en vez de la propia.' },
      { key: 'whatsappAudio', label: 'Notas de voz', type: 'boolean', default: false },
      { key: 'whatsappCatalog', label: 'Catálogo de productos', type: 'boolean', default: false },
      { key: 'whatsappDocument', label: 'Adjuntar documentos', type: 'boolean', default: false },
      { key: 'markerEditor', label: 'Editor de imágenes', type: 'boolean', default: false },
      { key: 'addProduct', label: 'Agregar producto', type: 'boolean', default: true, hint: 'Acción "Agregar producto" en el registro.' },
      { key: 'selectImage', label: 'Seleccionar imagen', type: 'boolean', default: true, hint: 'Acción "Seleccionar imagen" (galería) en el registro.' },
      { key: 'pasteImage', label: 'Pegar imagen', type: 'boolean', default: true, hint: 'Acción "Pegar imagen" (portapapeles) en el registro.' },
      { key: 'operationTypesLimit', label: 'Límite de tipos de operación', type: 'number', default: 0, hint: '0 = sin límite.' },
    ],
  })
})

/**
 * GET /api/mfe/config-state?companyId=xxx
 *
 * Estado ROOT EFECTIVO de una empresa, para que panel-root lo importe/administre
 * desde un solo lugar (Req 8.1, 8.4, 8.5). Reutiliza la misma lógica que
 * `GET /settings/features` (vía lib/features) para que ambos contratos coincidan.
 */
mfeRouter.get('/config-state', async (req, res) => {
  const companyId = (req.query.companyId as string)?.trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const doc = await getDb().collection('company_settings').findOne({ companyId }) as Record<string, unknown> | null
    const allowed = readAllowed(doc)
    res.json({
      companyId,
      allowedFeatures: allowed,
      operationTypesLimit: readOperationTypesLimit(doc),
      integrations: { turnos: { linked: turnosLinked(allowed) } },
    })
  } catch (err) {
    console.error('[mfe] Error al leer config-state:', err)
    res.status(500).json({ message: 'Error al leer el estado de configuración.' })
  }
})
