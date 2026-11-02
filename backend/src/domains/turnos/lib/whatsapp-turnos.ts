/**
 * Cliente de WhatsApp Web vía Baileys para el módulo de TURNOS/ASISTENCIA.
 *
 * Cada empresa vincula su propio WhatsApp para enviar notificaciones de turnos,
 * recordatorios de clase y confirmaciones de asistencia.
 *
 * ⚠️ Automatizar WhatsApp Web viola los TOS de WhatsApp; el número puede ser
 * baneado. Úsese bajo responsabilidad propia y preferiblemente con un número
 * secundario.
 *
 * La CONEXIÓN ahora la gestiona el gestor ÚNICO compartido (`src/whatsapp`),
 * que aporta backoff, keep-alive y watchdog. Este archivo solo conserva las
 * firmas que consumen las rutas y aporta los envíos específicos de turnos.
 *
 * Se activa con ENABLE_WHATSAPP_TURNOS=true. La sesión se persiste en Mongo
 * (colección `whatsapp_turnos_auth`) para sobrevivir a los reinicios.
 */

import { generateWAMessageFromContent, proto, type WAMessage } from '@whiskeysockets/baileys'
import { WhatsAppSessionManager, toJid as toJidShared } from '../../../whatsapp/session-manager.js'
import { getDb } from './mongodb.js'

const MESSAGES_COLLECTION = 'whatsapp_turnos_messages'

const manager = new WhatsAppSessionManager({
  channel: 'turnos',
  domain: 'turnos',
  envFlag: 'ENABLE_WHATSAPP_TURNOS',
  authCollection: 'whatsapp_turnos_auth',
  disabledMessage: 'WhatsApp de Turnos está desactivado (define ENABLE_WHATSAPP_TURNOS=true).',
  notConnectedMessage: 'WhatsApp de Turnos no está conectado para esta empresa. Escanea el QR primero.',
  persistInbound: async (m, companyId) => {
    const db = await getDb()
    // Respuesta de botones nativos (quick_reply): viene como JSON en
    // interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
    let btnId: string | null = null
    let btnText: string | null = null
    const flowJson = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    if (flowJson) {
      try {
        const parsed = JSON.parse(flowJson) as { id?: string; display_text?: string }
        btnId = parsed.id ?? null
        btnText = parsed.display_text ?? null
      } catch { /* noop */ }
    }
    // Fallback a botones/plantillas legacy
    const legacyBtnId = m.message?.templateButtonReplyMessage?.selectedId
      ?? m.message?.buttonsResponseMessage?.selectedButtonId
      ?? null
    const legacyBtnText = m.message?.templateButtonReplyMessage?.selectedDisplayText
      ?? m.message?.buttonsResponseMessage?.selectedDisplayText
      ?? null

    await db.collection(MESSAGES_COLLECTION).insertOne({
      direction: 'inbound',
      companyId,
      from: m.key.remoteJid ?? null,
      pushName: m.pushName ?? null,
      body: m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? btnText ?? legacyBtnText ?? null,
      selectedRowId: m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ?? btnId ?? legacyBtnId ?? null,
      selectedRowTitle: m.message?.listResponseMessage?.title ?? btnText ?? legacyBtnText ?? null,
      messageId: m.key.id ?? null,
      createdAt: new Date().toISOString(),
    })
  },
})

export function isWhatsAppTurnosEnabled(): boolean {
  return manager.isEnabled()
}

export function getStatus(companyId?: string) {
  return manager.getStatus(companyId)
}

export function getQrDataUrl(companyId?: string): string | null {
  return manager.getQrDataUrl(companyId)
}

export async function startWhatsAppTurnos(companyId?: string): Promise<void> {
  return manager.start(companyId)
}

/**
 * Watchdog: reconecta las sesiones que quedaron caídas y no fueron cerradas por
 * el usuario. Se llama periódicamente desde el arranque del dominio.
 */
export function reconnectDroppedSessions(): Promise<void> {
  return manager.reconnectDroppedSessions()
}

/** Reanuda al arrancar el backend las sesiones que ya tenían credenciales guardadas. */
export function resumeSavedSessions(): Promise<void> {
  return manager.resumeSavedSessions()
}

/** Normaliza un destino a JID de WhatsApp. Acepta número (+57...) o JID (grupo @g.us). */
export const toJid = toJidShared

/** Envía texto a un número o grupo. */
export async function sendText(to: string, text: string, companyId?: string): Promise<{ id: string | null }> {
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, { text })
  return { id: res?.key?.id ?? null }
}

/**
 * Envía una imagen. `image` puede ser un Buffer o una URL http(s).
 */
export async function sendImage(
  to: string,
  image: Buffer | string,
  caption?: string,
  companyId?: string,
): Promise<{ id: string | null }> {
  const msg: Record<string, unknown> = { image: typeof image === 'string' ? { url: image } : image }
  if (caption) msg.caption = caption
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, msg)
  return { id: res?.key?.id ?? null }
}

/**
 * Envía un álbum de varias imágenes (hasta 30 en un solo mensaje).
 *
 * WhatsApp agrupa automáticamente las imágenes enviadas en secuencia rápida.
 */
export async function sendAlbum(
  to: string,
  images: Array<{ image: Buffer | string; caption?: string }>,
  caption?: string,
  companyId?: string,
): Promise<{ id: string | null; count: number }> {
  if (images.length === 0) return { id: null, count: 0 }

  let firstId: string | null = null
  let count = 0

  for (let i = 0; i < images.length; i++) {
    const it = images[i]
    const img = typeof it.image === 'string' ? { url: it.image } : it.image

    // El caption global va en la primera imagen.
    // Si la imagen individual tiene su propio caption, se usa ese (prioridad).
    const finalCaption = it.caption ?? (i === 0 ? caption : undefined)

    const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, {
      image: img,
      ...(finalCaption ? { caption: finalCaption } : {}),
    })

    if (i === 0) firstId = res?.key?.id ?? null
    count++

    // Pequeña pausa para no saturar y permitir que WhatsApp agrupe.
    if (i < images.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  return { id: firstId, count }
}

/**
 * Envía un documento/archivo (PDF, Excel, etc.). `document` puede ser Buffer o URL.
 */
export async function sendDocument(
  to: string,
  document: Buffer | string,
  fileName: string,
  caption?: string,
  companyId?: string,
  mimetype?: string,
): Promise<{ id: string | null }> {
  // Sin mimetype WhatsApp muestra el archivo como adjunto genérico. Lo inferimos
  // de la extensión del nombre si no viene explícito.
  const msg: Record<string, unknown> = {
    document: typeof document === 'string' ? { url: document } : document,
    fileName,
    mimetype: mimetype || guessMimeFromName(fileName),
  }
  if (caption) msg.caption = caption
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, msg)
  return { id: res?.key?.id ?? null }
}

/** Infiera el mimetype a partir de la extensión del nombre de archivo. */
function guessMimeFromName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    zip: 'application/zip',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * Envía un audio (nota de voz). `audio` puede ser Buffer o URL.
 */
export async function sendAudio(
  to: string,
  audio: Buffer | string,
  companyId?: string,
  mimetype?: string,
): Promise<{ id: string | null }> {
  // WhatsApp sólo reproduce notas de voz como audio/ogg (opus) o audio/mp4.
  // Chrome graba webm/opus (mismo códec opus); se reenvía declarando
  // audio/ogg; codecs=opus para que WhatsApp lo muestre como nota de voz y no
  // como archivo descargable. Para mp4/m4a se mantiene su tipo.
  const m = (mimetype || '').toLowerCase()
  const isOpus = m.includes('webm') || m.includes('ogg') || m.includes('opus') || !m
  const finalMime = isOpus ? 'audio/ogg; codecs=opus' : (m.includes('mp4') || m.includes('m4a') ? 'audio/mp4' : mimetype!)
  const msg: Record<string, unknown> = {
    audio: typeof audio === 'string' ? { url: audio } : audio,
    mimetype: finalMime,
    ptt: true,
  }
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, msg)
  return { id: res?.key?.id ?? null }
}

/**
 * Opciones para un mensaje interactivo de lista (single-select).
 * `rows` son las opciones que el usuario podrá seleccionar.
 */
export interface ListRow {
  id: string
  title: string
  description?: string
}

/**
 * Envía un mensaje interactivo de lista (opción múltiple) a un número o grupo.
 * WhatsApp Web soporta listas de selección única. El usuario recibirá un
 * mensaje con un botón "Toca para seleccionar" y al pulsarlo verá las opciones.
 */
export async function sendListMessage(
  to: string,
  title: string,
  buttonText: string,
  rows: ListRow[],
  companyId?: string,
): Promise<{ id: string | null }> {
  const sections = [{
    title: 'Opciones',
    rows: rows.map((r) => ({
      title: r.title,
      rowId: r.id,
      description: r.description,
    })),
  }]
  const listMessage: Record<string, unknown> = {
    text: title,
    footer: 'Selecciona una opción',
    buttonText: buttonText || 'Seleccionar',
    sections,
    listType: 1,
  }
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, to, listMessage)
  return { id: res?.key?.id ?? null }
}

/**
 * Envía un mensaje con botones de respuesta rápida NATIVOS (hasta 3 opciones).
 *
 * Usa `interactiveMessage` + `nativeFlowMessage` con botones `quick_reply`, que
 * es el formato que WhatsApp renderiza como botones reales bajo el mensaje
 * (a diferencia del `buttonsMessage` legacy, que WhatsApp degrada a texto).
 */
export async function sendButtonsMessage(
  to: string,
  text: string,
  buttons: Array<{ id: string; text: string }>,
  companyId?: string,
): Promise<{ id: string | null }> {
  const sock = await manager.waitForOpen(companyId)
  const jid = toJid(to)

  const nativeButtons = buttons.slice(0, 3).map((b) => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }),
  }))

  const content: proto.IMessage = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: proto.Message.InteractiveMessage.create({
          body: proto.Message.InteractiveMessage.Body.create({ text }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: 'Pulsa una opción para responder' }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: nativeButtons,
          }),
        }),
      },
    },
  }

  const userJid = sock.user?.id ?? ''
  const msg = generateWAMessageFromContent(jid, content, { userJid })
  await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id! })
  return { id: msg.key.id ?? null }
}

/** Lista los grupos (id JID + nombre) de la cuenta conectada. */
export async function listGroups(companyId?: string): Promise<Array<{ id: string; name: string }>> {
  const sock = await manager.waitForOpen(companyId)
  const groups = await sock.groupFetchAllParticipating()
  return Object.values(groups).map((g) => ({ id: g.id, name: g.subject ?? g.id }))
}

/** Cierra la sesión y borra las credenciales de una compañía (fuerza nuevo QR). */
export async function clearSession(companyId?: string): Promise<void> {
  return manager.clearSession(companyId)
}

/** Devuelve el último mensaje entrante de un JID (para leer respuestas). */
export async function getLastInbound(fromJid: string, companyId?: string): Promise<WAMessage | null> {
  const db = await getDb()
  const key = (companyId ?? '').trim() || 'default'
  const doc = await db.collection(MESSAGES_COLLECTION).findOne(
    { direction: 'inbound', companyId: key === 'default' ? null : key, from: fromJid },
    { sort: { createdAt: -1 } },
  )
  return (doc as unknown as WAMessage | null) ?? null
}
