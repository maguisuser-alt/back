/**
 * Integración con WhatsApp mediante Twilio (API oficial de WhatsApp Business).
 *
 * Permite enviar mensajes de texto e imágenes (por URL pública) a un número de
 * WhatsApp individual. La recepción de mensajes entrantes se maneja mediante un
 * webhook (ver routes/whatsapp.ts).
 *
 * Variables de entorno:
 *   TWILIO_ACCOUNT_SID    - SID de la cuenta Twilio
 *   TWILIO_AUTH_TOKEN     - Auth Token de Twilio
 *   TWILIO_WHATSAPP_FROM  - Número remitente de WhatsApp en formato
 *                           'whatsapp:+14155238886' (sandbox) o el número propio
 *
 * Nota: la API oficial de WhatsApp NO permite enviar a grupos, solo a chats
 * individuales (números). Para iniciar conversación fuera de la ventana de 24h
 * se requieren plantillas aprobadas por Meta.
 */

import twilio from 'twilio'
import type { Twilio } from 'twilio'

let _client: Twilio | null = null

export function isWhatsAppConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM,
  )
}

function getClient(): Twilio {
  if (_client) return _client
  if (!isWhatsAppConfigured()) {
    throw new Error('WhatsApp (Twilio) no configurado. Define TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_WHATSAPP_FROM.')
  }
  _client = twilio(process.env.TWILIO_ACCOUNT_SID as string, process.env.TWILIO_AUTH_TOKEN as string)
  return _client
}

/** Normaliza un número al formato 'whatsapp:+<E164>' que espera Twilio. */
export function toWhatsAppAddress(input: string): string {
  const trimmed = (input || '').trim()
  if (trimmed.startsWith('whatsapp:')) return trimmed
  const digits = trimmed.replace(/[^\d+]/g, '')
  const e164 = digits.startsWith('+') ? digits : `+${digits}`
  return `whatsapp:${e164}`
}

export interface SendResult {
  sid: string
  status: string
  to: string
}

/** Envía un mensaje de texto a un número de WhatsApp. */
export async function sendWhatsAppText(to: string, body: string): Promise<SendResult> {
  const client = getClient()
  const msg = await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM as string,
    to: toWhatsAppAddress(to),
    body,
  })
  return { sid: msg.sid, status: msg.status, to: toWhatsAppAddress(to) }
}

/**
 * Envía una imagen (por URL pública) a un número de WhatsApp, con caption opcional.
 * La URL debe ser accesible públicamente por los servidores de Twilio/Meta
 * (p. ej. una URL pública o firmada de R2).
 *
 * Nota: el envío de media libre (sin plantilla) solo funciona dentro de la
 * ventana de 24h posterior a un mensaje del usuario. Para iniciar conversación
 * fuera de esa ventana usa sendWhatsAppTemplate.
 */
export async function sendWhatsAppImage(to: string, mediaUrl: string, caption?: string): Promise<SendResult> {
  const client = getClient()
  const msg = await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM as string,
    to: toWhatsAppAddress(to),
    mediaUrl: [mediaUrl],
    ...(caption ? { body: caption } : {}),
  })
  return { sid: msg.sid, status: msg.status, to: toWhatsAppAddress(to) }
}

/**
 * Envía un mensaje de PLANTILLA aprobada (Content Template) por su ContentSid.
 * Es la forma de iniciar una conversación fuera de la ventana de 24h.
 *
 * @param to            número destino
 * @param contentSid    SID de la plantilla (HX...). Si se omite, usa
 *                      TWILIO_TEMPLATE_CONTENT_SID del entorno.
 * @param variables     variables de la plantilla, p. ej. { "1": "Juan", "2": "ABC123" }
 * @param mediaUrl      (opcional) URL de media para plantillas con cabecera de imagen
 */
export async function sendWhatsAppTemplate(
  to: string,
  contentSid?: string,
  variables?: Record<string, string>,
  mediaUrl?: string,
): Promise<SendResult> {
  const client = getClient()
  const sid = contentSid || process.env.TWILIO_TEMPLATE_CONTENT_SID
  if (!sid) throw new Error('Falta el ContentSid de la plantilla (TWILIO_TEMPLATE_CONTENT_SID).')

  const msg = await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM as string,
    to: toWhatsAppAddress(to),
    contentSid: sid,
    ...(variables ? { contentVariables: JSON.stringify(variables) } : {}),
    ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
  })
  return { sid: msg.sid, status: msg.status, to: toWhatsAppAddress(to) }
}
