/**
 * Pegamento entre las plantillas de `whatsapp_turnos_config` y el envío real
 * por Baileys (whatsapp-turnos.ts).
 *
 * - Lee la configuración de mensajes por empresa + tipo.
 * - Interpola los placeholders {nombre} {fecha} {hora} {ubicacion} {materia}.
 * - Normaliza el teléfono a formato internacional colombiano (57...).
 * - Envía como texto, o como lista de opción múltiple si el tipo tiene options.
 */

import { getDb } from './mongodb.js'
import { sendText, sendListMessage, sendButtonsMessage } from './whatsapp-turnos.js'
import { DEFAULT_CONFIG } from '../routes/whatsapp-config.js'

const CONFIG_COLLECTION = 'whatsapp_turnos_config'

export type TemplateKey = 'turno_confirmacion' | 'turno_recordatorio' | 'clase_recordatorio'

export type TemplateVars = {
  nombre?: string
  fecha?: string
  hora?: string
  ubicacion?: string
  materia?: string
  cargo?: string
  mapa?: string
  link?: string
}

type MessageConfig = {
  enabled: boolean
  template: string
  options: { id: string; label: string }[]
}

/** Reemplaza {placeholder} por su valor (vacío si no viene). */
export function interpolate(template: string, vars: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key]
    return v != null ? String(v) : ''
  })
}

/**
 * Normaliza un teléfono a JID colombiano: quita no-dígitos, elimina 0 inicial,
 * antepone 57 si falta el indicativo.
 */
export function normalizePhone(raw: string): string {
  let digits = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) return ''
  if (!digits.startsWith('57')) digits = `57${digits}`
  return digits
}

/**
 * Devuelve la configuración de mensaje para una empresa+tipo.
 * Si la empresa no tiene config guardada (o le falta ese tipo), usa la
 * plantilla por defecto, de modo que el envío nunca falla por "no configurada".
 */
async function getMessageConfig(companyId: string, tipo: TemplateKey): Promise<MessageConfig> {
  const fallback = DEFAULT_CONFIG[tipo]
  const base: MessageConfig = {
    enabled: fallback.enabled,
    template: fallback.template,
    options: fallback.options.map((o) => ({ id: o.id, label: o.label })),
  }
  try {
    const db = await getDb()
    const doc = await db.collection(CONFIG_COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
    const cfg = doc?.[tipo] as Partial<MessageConfig> | undefined
    if (!cfg) return base
    return {
      enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : base.enabled,
      template: typeof cfg.template === 'string' && cfg.template.trim() ? cfg.template : base.template,
      options: Array.isArray(cfg.options) ? cfg.options : base.options,
    }
  } catch {
    return base
  }
}

export type SendTemplateResult = {
  sent: boolean
  reason?: string
  id?: string | null
  text?: string
}

/**
 * Envía una notificación basada en la plantilla configurada.
 * Si la plantilla define `options`, se envía como lista de opción múltiple
 * (para recibir la confirmación); si no, como texto plano.
 */
export async function sendTemplate(
  companyId: string,
  tipo: TemplateKey,
  phone: string,
  vars: TemplateVars,
  overrideTemplate?: string,
  userId?: string,
): Promise<SendTemplateResult> {
  const cfg = await getMessageConfig(companyId, tipo)

  const to = normalizePhone(phone)
  if (!to) return { sent: false, reason: 'Teléfono inválido o faltante.' }

  // Si el usuario envió un mensaje editado desde el modal, se usa ese;
  // si no, la plantilla de la empresa (o la de por defecto).
  const template = (overrideTemplate && overrideTemplate.trim()) ? overrideTemplate : cfg.template
  const baseText = interpolate(template, vars)

  if (cfg.options.length > 0) {
    // Hasta 3 opciones → botones de respuesta rápida NATIVOS (quick_reply),
    // que WhatsApp muestra como botones bajo el mensaje. El texto NO lleva las
    // opciones (ya las muestran los botones).
    if (cfg.options.length <= 3) {
      const buttons = cfg.options.map((o) => ({ id: `${tipo}:${o.id}`, text: o.label }))
      try {
        const result = await sendButtonsMessage(to, baseText, buttons, companyId, userId)
        return { sent: true, id: result.id, text: baseText }
      } catch {
        // Fallback: si por algún motivo falla el envío nativo, anexa las
        // opciones como lista numerada para no perder la posibilidad de respuesta.
        const numbered = cfg.options.map((o, i) => `${i + 1}️⃣ ${o.label}`).join('\n')
        const text = `${baseText}\n\n————————————\n👉 *Responde con el número de tu elección:*\n${numbered}`
        const result = await sendText(to, text, companyId, userId)
        return { sent: true, id: result.id, text }
      }
    }
    // Más de 3 → lista desplegable nativa.
    const rows = cfg.options.map((o) => ({ id: `${tipo}:${o.id}`, title: o.label }))
    const result = await sendListMessage(to, baseText, 'Responder', rows, companyId, userId)
    return { sent: true, id: result.id, text: baseText }
  }

  const result = await sendText(to, baseText, companyId, userId)
  return { sent: true, id: result.id, text: baseText }
}
