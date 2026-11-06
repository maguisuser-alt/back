/**
 * Rutas de WhatsApp Web (Baileys, vía QR) para el módulo de TURNOS.
 *
 * Instancia SEPARADA de la de trazabilidad: cada empresa vincula su propio
 * WhatsApp para notificaciones de turnos, asistencia y recordatorios.
 *
 * Solo se montan si ENABLE_WHATSAPP_TURNOS=true.
 *
 *  - GET  /api/whatsapp-turnos/status  → estado de conexión
 *  - GET  /api/whatsapp-turnos/qr      → QR (image/png o data URL)
 *  - POST /api/whatsapp-turnos/start   → inicia la conexión
 *  - POST /api/whatsapp-turnos/pairing-code → genera código de vinculación por número
 *  - POST /api/whatsapp-turnos/logout  → cierra sesión y borra credenciales
 *  - POST /api/whatsapp-turnos/send-text    → envía texto a un número/grupo
 *  - POST /api/whatsapp-turnos/send-list    → envía mensaje de opción múltiple (lista)
 *  - POST /api/whatsapp-turnos/send-buttons → envía mensaje con botones
 */

import { Router } from 'express'
import {
  startWhatsAppTurnos, getStatus, getQrDataUrl, requestPairingCode, sendText, sendListMessage,
  sendButtonsMessage, sendImage, sendAlbum, sendDocument, sendAudio,
  listGroups, clearSession, toJid,
} from '../lib/whatsapp-turnos.js'
import { sendTemplate, interpolate, type TemplateKey, type TemplateVars } from '../lib/whatsapp-templates.js'
import { DEFAULT_CONFIG } from './whatsapp-config.js'
import { getDb } from '../lib/mongodb.js'
import { readDatabase } from '../lib/database.js'

/** Construye las variables dinámicas (nombre, cargo, fecha...) de un turno. */
function buildTurnVars(turn: any, worker: any, location: any): TemplateVars {
  const mapa = location?.latitud && location?.longitud
    ? `https://maps.google.com/?q=${location.latitud},${location.longitud}`
    : (location?.direccion ?? '')
  const base = (process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '')
  const link = base ? `${base}/dashboard/asignacion-turnos` : 'Consulta la app de Ommex Turnos.'
  const horario = turn.horaFin ? `${turn.hora} - ${turn.horaFin}` : turn.hora
  return {
    nombre: worker?.nombreCompleto,
    cargo: worker?.cargo,
    fecha: turn.fecha,
    hora: horario,
    ubicacion: turn.locationNombre ?? location?.nombre ?? '',
    mapa,
    link,
  }
}

export const whatsappTurnosRouter = Router()

const VALID_TEMPLATES: TemplateKey[] = ['turno_confirmacion', 'turno_recordatorio', 'clase_recordatorio']

/**
 * Usuario dueño de la sesión de WhatsApp. La vinculación es POR USUARIO dentro
 * de la compañía, así que el `userId` viaja en body o query (los frontends lo
 * envían desde la sesión activa). Si no viene, se conserva la sesión a nivel
 * compañía (compatibilidad).
 */
function reqUserId(req: { body?: any; query?: any }): string | undefined {
  return (req.body?.userId as string) || (req.query.userId as string) || undefined
}

whatsappTurnosRouter.get('/status', (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  res.json(getStatus(companyId, reqUserId(req)))
})

whatsappTurnosRouter.post('/start', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  try {
    await startWhatsAppTurnos(companyId, userId)
    res.json(getStatus(companyId, userId))
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo iniciar WhatsApp de Turnos.' })
  }
})

whatsappTurnosRouter.get('/qr', async (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  try {
    const st = getStatus(companyId, userId)
    if (st.status === 'disconnected') await startWhatsAppTurnos(companyId, userId)

    const dataUrl = getQrDataUrl(companyId, userId)
    if (!dataUrl) {
      res.status(202).json({ message: 'QR aún no disponible. Reintenta en 1-2 segundos.', status: getStatus(companyId, userId).status })
      return
    }
    if ((req.query.format as string) === 'json') {
      res.json({ qr: dataUrl, status: getStatus(companyId, userId).status })
      return
    }
    const base64 = dataUrl.split(',')[1]
    const buf = Buffer.from(base64, 'base64')
    res.set('Content-Type', 'image/png').send(buf)
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo obtener el QR.' })
  }
})

/**
 * Genera un código de vinculación (pairing code) para vincular por número.
 * Alternativa al QR: el código se ingresa en el teléfono desde
 * WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.
 */
whatsappTurnosRouter.post('/pairing-code', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  const phoneNumber = (req.body?.phoneNumber as string) || ''
  if (!phoneNumber) { res.status(400).json({ message: 'Debes enviar "phoneNumber" en formato internacional (p. ej. 573001234567).' }); return }
  try {
    const code = await requestPairingCode(companyId, userId, phoneNumber)
    res.json({ pairingCode: code, status: getStatus(companyId, userId).status })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo generar el código de vinculación.' })
  }
})

whatsappTurnosRouter.post('/send-text', async (req, res) => {
  const { to, text, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido (número o JID de grupo).' }); return }
  if (!text) { res.status(400).json({ message: 'Debes enviar "text".' }); return }

  try {
    const result = await sendText(to, text, companyId, userId)
    res.json({ message: 'Mensaje enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje.' })
  }
})

whatsappTurnosRouter.post('/send-image', async (req, res) => {
  const { to, imageUrl, base64, caption, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!imageUrl && !base64) { res.status(400).json({ message: 'Debes enviar "imageUrl" o "base64".' }); return }
  try {
    const image: Buffer | string = base64
      ? Buffer.from(base64, 'base64')
      : imageUrl
    const result = await sendImage(to, image, caption, companyId, userId)
    res.json({ message: 'Imagen enviada.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar la imagen.' })
  }
})

whatsappTurnosRouter.post('/send-album', async (req, res) => {
  const { to, images, caption, companyId, captionPosition } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!Array.isArray(images) || images.length === 0) {
    res.status(400).json({ message: 'Debes enviar "images" (array).' }); return
  }
  try {
    const items = images.map((it: any) => ({
      image: it.base64 ? Buffer.from(it.base64, 'base64') : it.imageUrl,
      caption: it.caption,
    }))
    const result = await sendAlbum(to, items, caption, companyId, userId, captionPosition === 'last' ? 'last' : 'first')
    res.json({ message: `Álbum enviado (${result.count} foto(s)).`, id: result.id, count: result.count })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el álbum.' })
  }
})

whatsappTurnosRouter.post('/send-document', async (req, res) => {
  const { to, documentUrl, base64, fileName, caption, mimetype, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!documentUrl && !base64) { res.status(400).json({ message: 'Debes enviar "documentUrl" o "base64".' }); return }
  try {
    const document: Buffer | string = base64 ? Buffer.from(base64, 'base64') : documentUrl
    const result = await sendDocument(to, document, fileName ?? 'archivo', caption, companyId, mimetype, userId)
    res.json({ message: 'Documento enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el documento.' })
  }
})

whatsappTurnosRouter.post('/send-audio', async (req, res) => {
  const { to, audioUrl, base64, mimetype, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!audioUrl && !base64) { res.status(400).json({ message: 'Debes enviar "audioUrl" o "base64".' }); return }
  try {
    const audio: Buffer | string = base64 ? Buffer.from(base64, 'base64') : audioUrl
    const result = await sendAudio(to, audio, companyId, mimetype, userId)
    res.json({ message: 'Audio enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el audio.' })
  }
})

whatsappTurnosRouter.post('/send-list', async (req, res) => {
  const { to, title, buttonText, rows, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ message: 'Debes enviar "rows" (array de opciones).' }); return
  }

  try {
    const result = await sendListMessage(to, title ?? '', buttonText ?? 'Seleccionar', rows, companyId, userId)
    res.json({ message: 'Mensaje de opción múltiple enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje de opción múltiple.' })
  }
})

whatsappTurnosRouter.post('/send-buttons', async (req, res) => {
  const { to, text, buttons, companyId } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido.' }); return }
  if (!buttons || !Array.isArray(buttons) || buttons.length === 0) {
    res.status(400).json({ message: 'Debes enviar "buttons" (array de botones).' }); return
  }

  try {
    const result = await sendButtonsMessage(to, text ?? '', buttons, companyId, userId)
    res.json({ message: 'Mensaje con botones enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje con botones.' })
  }
})

/**
 * POST /api/whatsapp-turnos/send-template
 * Interpola una plantilla configurada en whatsapp_turnos_config y la envía.
 * Body: { companyId, tipo, to, vars }
 *   - tipo: turno_confirmacion | turno_recordatorio | clase_recordatorio
 *   - to:   teléfono del destinatario (se normaliza a 57...)
 *   - vars: { nombre, fecha, hora, ubicacion, materia }
 */
whatsappTurnosRouter.post('/send-template', async (req, res) => {
  const { companyId, tipo, to, vars } = req.body ?? {}
  const userId = reqUserId(req)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!tipo || !VALID_TEMPLATES.includes(tipo)) {
    res.status(400).json({ message: 'tipo inválido. Usa turno_confirmacion, turno_recordatorio o clase_recordatorio.' }); return
  }
  if (!to) { res.status(400).json({ message: 'El destino "to" (teléfono) es requerido.' }); return }

  try {
    const result = await sendTemplate(companyId, tipo as TemplateKey, String(to), (vars ?? {}) as TemplateVars, undefined, userId)
    if (!result.sent) { res.status(409).json({ message: result.reason ?? 'No se pudo enviar.' }); return }
    res.json({ message: 'Mensaje enviado.', id: result.id, text: result.text })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje.' })
  }
})

/**
 * GET /api/whatsapp-turnos/turn-template?turnId=xxx
 * Devuelve la plantilla (de la empresa o por defecto), las variables dinámicas
 * del turno (nombre, cargo, fecha, etc.) y una vista previa interpolada.
 * Sirve para que el modal muestre y permita editar el mensaje antes de enviar.
 */
whatsappTurnosRouter.get('/turn-template', async (req, res) => {
  const turnId = req.query.turnId as string
  if (!turnId) { res.status(400).json({ message: 'turnId es requerido.' }); return }
  try {
    const db = await readDatabase()
    const turn = db.turns.find((t) => t.id === turnId)
    if (!turn) { res.status(404).json({ message: 'Turno no encontrado.' }); return }
    const worker = turn.assignedToUserId ? db.users.find((u) => u.id === turn.assignedToUserId) : undefined
    const location = turn.locationId ? db.locations.find((l) => l.id === turn.locationId) : undefined

    // Plantilla: la de la empresa si existe, si no la de por defecto.
    let template = DEFAULT_CONFIG.turno_confirmacion.template
    let options = DEFAULT_CONFIG.turno_confirmacion.options
    try {
      const mdb = await getDb()
      const doc = await mdb.collection('whatsapp_turnos_config').findOne({ companyId: turn.companyId }) as Record<string, unknown> | null
      const cfg = doc?.turno_confirmacion as { template?: string; options?: { id: string; label: string }[] } | undefined
      if (cfg?.template?.trim()) template = cfg.template
      if (Array.isArray(cfg?.options)) options = cfg.options
    } catch { /* usa default */ }

    const vars = buildTurnVars(turn, worker, location)
    res.json({
      template,
      vars,
      options,
      preview: interpolate(template, vars),
      telefono: worker?.telefono ?? '',
      placeholders: ['nombre', 'cargo', 'fecha', 'hora', 'ubicacion', 'mapa', 'link'],
    })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo cargar la plantilla.' })
  }
})

/**
 * POST /api/whatsapp-turnos/send-turn-confirmation
 * Envía la confirmación de un turno al trabajador asignado usando la plantilla
 * `turno_confirmacion` y los datos reales del turno.
 * Body: { turnId, to?, message? }  (message = plantilla editada opcional)
 */
whatsappTurnosRouter.post('/send-turn-confirmation', async (req, res) => {
  const { turnId, to, message } = req.body ?? {}
  const userId = reqUserId(req)
  if (!turnId) { res.status(400).json({ message: 'turnId es requerido.' }); return }

  try {
    const db = await readDatabase()
    const turn = db.turns.find((t) => t.id === turnId)
    if (!turn) { res.status(404).json({ message: 'Turno no encontrado.' }); return }

    const worker = turn.assignedToUserId
      ? db.users.find((u) => u.id === turn.assignedToUserId)
      : undefined
    if (!worker) { res.status(404).json({ message: 'El turno no tiene trabajador asignado.' }); return }
    // Destino: el número/grupo explícito del request, o el teléfono del empleado.
    const destino = (typeof to === 'string' && to.trim()) ? to.trim() : worker.telefono
    if (!destino) { res.status(409).json({ message: `${worker.nombreCompleto} no tiene teléfono registrado. Indica un número en el modal.` }); return }

    const location = turn.locationId ? db.locations.find((l) => l.id === turn.locationId) : undefined
    const vars = buildTurnVars(turn, worker, location)
    const override = typeof message === 'string' && message.trim() ? message : undefined
    const result = await sendTemplate(turn.companyId, 'turno_confirmacion', destino, vars, override, userId)
    if (!result.sent) { res.status(409).json({ message: result.reason ?? 'No se pudo enviar.' }); return }
    res.json({ message: 'Confirmación de turno enviada.', id: result.id, text: result.text })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar la confirmación.' })
  }
})

/**
 * POST /api/whatsapp-turnos/send-invitation
 * Envía por WhatsApp una invitación de registro.
 * Body: { companyId, to, nombre?, invitePath | url }
 * Construye un texto con el enlace de registro. No usa plantilla de config
 * (la invitación es un flujo propio), pero reutiliza sendText con normalización.
 */
whatsappTurnosRouter.post('/send-invitation', async (req, res) => {
  const { companyId, to, nombre, url, invitePath } = req.body ?? {}
  const userId = reqUserId(req)
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  if (!to) { res.status(400).json({ message: 'El destino "to" (teléfono) es requerido.' }); return }
  const link = url ?? invitePath
  if (!link) { res.status(400).json({ message: 'Debes enviar "url" o "invitePath" con el enlace de registro.' }); return }

  const { normalizePhone } = await import('../lib/whatsapp-templates.js')
  const dest = normalizePhone(String(to))
  if (!dest) { res.status(400).json({ message: 'Teléfono inválido.' }); return }

  const saludo = nombre ? `Hola ${nombre}, ` : 'Hola, '
  const text = `${saludo}te han invitado a registrarte en Ommex. Completa tu registro aquí:\n${link}`

  try {
    const result = await sendText(dest, text, String(companyId), userId)
    res.json({ message: 'Invitación enviada.', id: result.id, text })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar la invitación.' })
  }
})

/**
 * GET /api/whatsapp-turnos/groups?companyId=xxx
 * Lista los grupos (id JID + nombre) de la cuenta conectada.
 */
whatsappTurnosRouter.get('/groups', async (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  try {
    const groups = await listGroups(companyId, reqUserId(req))
    res.json({ groups })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudieron listar los grupos.' })
  }
})

whatsappTurnosRouter.post('/logout', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  try {
    await clearSession(companyId, userId)
    res.json({ message: 'Sesión cerrada. Escanea el QR para volver a conectar.' })
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'No se pudo cerrar la sesión.' })
  }
})
