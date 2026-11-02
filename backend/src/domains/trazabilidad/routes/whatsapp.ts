/**
 * Rutas de WhatsApp (vía Twilio, API oficial).
 *
 *  - POST /api/whatsapp/send
 *      Envía una imagen (por URL) o texto a un número de WhatsApp.
 *      Body: { to, mediaUrl?, caption?, text?, companyId?, trackingCode? }
 *
 *  - POST /api/whatsapp/send-upload
 *      Sube una imagen (base64) a R2 y la envía por WhatsApp en un solo paso.
 *      Body: { to, base64, mimeType?, caption?, companyId?, trackingCode? }
 *
 *  - POST /api/whatsapp/webhook
 *      Webhook que Twilio invoca al recibir un mensaje entrante. Guarda el
 *      mensaje en MongoDB (colección whatsapp_messages). Responde 200 rápido.
 *
 *  - GET  /api/whatsapp/messages?companyId=&from=
 *      Lista los mensajes recibidos (para un panel de chats en la app).
 */

import { Router, urlencoded } from 'express'
import { getDb } from '../lib/mongodb.js'
import { isWhatsAppConfigured, sendWhatsAppImage, sendWhatsAppText, sendWhatsAppTemplate } from '../lib/whatsapp.js'
import { isStorageConfigured, uploadImage } from '../lib/storage.js'

export const whatsappRouter = Router()

const COLLECTION = 'whatsapp_messages'

/**
 * POST /api/whatsapp/send
 * Envía texto o imagen (por URL ya existente) a un número.
 */
whatsappRouter.post('/send', async (req, res) => {
  const { to, mediaUrl, caption, text, companyId, trackingCode } = req.body ?? {}
  if (!to) { res.status(400).json({ message: 'El número destino "to" es requerido.' }); return }
  if (!mediaUrl && !text) { res.status(400).json({ message: 'Debes enviar "mediaUrl" (imagen) o "text".' }); return }
  if (!isWhatsAppConfigured()) { res.status(502).json({ message: 'WhatsApp (Twilio) no está configurado en el servidor.' }); return }

  try {
    const result = mediaUrl
      ? await sendWhatsAppImage(to, mediaUrl, caption)
      : await sendWhatsAppText(to, text)

    // Registrar el saliente (best-effort)
    try {
      await getDb().collection(COLLECTION).insertOne({
        direction: 'outbound',
        to: result.to,
        mediaUrl: mediaUrl ?? null,
        body: caption ?? text ?? null,
        sid: result.sid,
        status: result.status,
        companyId: companyId ?? null,
        trackingCode: trackingCode ?? null,
        createdAt: new Date().toISOString(),
      })
    } catch { /* db opcional */ }

    res.json({ message: 'Mensaje enviado.', sid: result.sid, status: result.status })
  } catch (err) {
    console.error('[whatsapp] Error al enviar:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje.' })
  }
})

/**
 * POST /api/whatsapp/send-template
 * Envía un mensaje de plantilla aprobada (para iniciar conversación fuera de 24h).
 * Body: { to, contentSid?, variables?, mediaUrl?, companyId?, trackingCode? }
 */
whatsappRouter.post('/send-template', async (req, res) => {
  const { to, contentSid, variables, mediaUrl, companyId, trackingCode } = req.body ?? {}
  if (!to) { res.status(400).json({ message: 'El número destino "to" es requerido.' }); return }
  if (!isWhatsAppConfigured()) { res.status(502).json({ message: 'WhatsApp (Twilio) no está configurado en el servidor.' }); return }

  try {
    const result = await sendWhatsAppTemplate(to, contentSid, variables, mediaUrl)
    try {
      await getDb().collection(COLLECTION).insertOne({
        direction: 'outbound',
        type: 'template',
        to: result.to,
        contentSid: contentSid ?? process.env.TWILIO_TEMPLATE_CONTENT_SID ?? null,
        variables: variables ?? null,
        mediaUrl: mediaUrl ?? null,
        sid: result.sid,
        status: result.status,
        companyId: companyId ?? null,
        trackingCode: trackingCode ?? null,
        createdAt: new Date().toISOString(),
      })
    } catch { /* db opcional */ }
    res.json({ message: 'Plantilla enviada.', sid: result.sid, status: result.status })
  } catch (err) {
    console.error('[whatsapp] Error al enviar plantilla:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar la plantilla.' })
  }
})

/**
 * POST /api/whatsapp/send-upload
 * Sube la imagen (base64) a R2 y la envía por WhatsApp.
 */
whatsappRouter.post('/send-upload', async (req, res) => {
  const { to, base64, mimeType, caption, companyId, trackingCode } = req.body ?? {}
  if (!to) { res.status(400).json({ message: 'El número destino "to" es requerido.' }); return }
  if (!base64) { res.status(400).json({ message: '"base64" (imagen) es requerido.' }); return }
  if (!isStorageConfigured()) { res.status(502).json({ message: 'Almacenamiento R2 no está configurado en el servidor.' }); return }
  if (!isWhatsAppConfigured()) { res.status(502).json({ message: 'WhatsApp (Twilio) no está configurado en el servidor.' }); return }

  try {
    const up = await uploadImage(base64, {
      contentType: mimeType || 'image/jpeg',
      keyPrefix: `whatsapp/${companyId ?? 'general'}`,
    })
    // Twilio/Meta necesitan una URL accesible públicamente para la media.
    const result = await sendWhatsAppImage(to, up.url, caption)

    try {
      await getDb().collection(COLLECTION).insertOne({
        direction: 'outbound',
        to: result.to,
        mediaUrl: up.url,
        mediaKey: up.key,
        body: caption ?? null,
        sid: result.sid,
        status: result.status,
        companyId: companyId ?? null,
        trackingCode: trackingCode ?? null,
        createdAt: new Date().toISOString(),
      })
    } catch { /* db opcional */ }

    res.json({ message: 'Imagen subida y enviada.', sid: result.sid, status: result.status, url: up.url })
  } catch (err) {
    console.error('[whatsapp] Error en send-upload:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo subir/enviar la imagen.' })
  }
})

/**
 * POST /api/whatsapp/webhook
 * Twilio envía los mensajes entrantes como x-www-form-urlencoded.
 * Guardamos lo esencial y respondemos 200 (TwiML vacío) de inmediato.
 */
whatsappRouter.post('/webhook', urlencoded({ extended: false }), async (req, res) => {
  // Responder rápido para que Twilio no reintente.
  res.set('Content-Type', 'text/xml').status(200).send('<Response></Response>')

  try {
    const b = req.body ?? {}
    const numMedia = Number(b.NumMedia ?? 0)
    const media: Array<{ url: string; contentType: string }> = []
    for (let i = 0; i < numMedia; i++) {
      const url = b[`MediaUrl${i}`]
      const ct = b[`MediaContentType${i}`]
      if (url) media.push({ url, contentType: ct ?? '' })
    }

    await getDb().collection(COLLECTION).insertOne({
      direction: 'inbound',
      from: b.From ?? null,          // 'whatsapp:+57...'
      to: b.To ?? null,
      profileName: b.ProfileName ?? null,
      body: b.Body ?? null,
      media,
      sid: b.MessageSid ?? b.SmsSid ?? null,
      raw: b,                        // guardamos el payload completo por si acaso
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    // Ya respondimos 200; solo registramos el fallo de persistencia.
    console.warn('[whatsapp] No se pudo guardar el mensaje entrante:', err instanceof Error ? err.message : err)
  }
})

/**
 * GET /api/whatsapp/messages?companyId=&from=&limit=
 * Lista los mensajes (entrantes y salientes) para un panel de chats.
 */
whatsappRouter.get('/messages', async (req, res) => {
  const { companyId, from, limit } = req.query as Record<string, string>
  const q: Record<string, unknown> = {}
  if (companyId) q.companyId = companyId
  if (from) q.from = from
  const max = Math.min(Number(limit) || 100, 500)
  try {
    const docs = await getDb().collection(COLLECTION)
      .find(q, { projection: { _id: 0, raw: 0 } })
      .sort({ createdAt: -1 })
      .limit(max)
      .toArray()
    res.json({ messages: docs })
  } catch (err) {
    console.error('[whatsapp] Error al listar mensajes:', err)
    res.status(500).json({ message: 'Error al listar los mensajes.' })
  }
})
