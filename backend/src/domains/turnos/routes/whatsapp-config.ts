/**
 * Configuración de mensajes de WhatsApp por empresa para el módulo de TURNOS.
 *
 * Cada empresa puede configurar, por tipo de notificación:
 *  - si está activada
 *  - la plantilla del mensaje (con placeholders)
 *  - las opciones de respuesta múltiple (para recibir confirmaciones)
 *
 * Tipos predefinidos:
 *  - turno_confirmacion  → Confirmación de asistencia de turno
 *  - turno_recordatorio  → Recordatorio de turno de trabajo
 *  - clase_recordatorio  → Recordatorio de asistencia de clase
 *
 * GET  /api/whatsapp-config?companyId=xxx        → devuelve la configuración
 * PUT  /api/whatsapp-config                       → guarda la configuración
 */

import { Router } from 'express'
import { getDb } from '../lib/mongodb.js'

export const whatsappConfigRouter = Router()

const COLLECTION = 'whatsapp_turnos_config'

export type WhatsAppMessageOption = {
  id: string
  label: string
}

export type WhatsAppMessageConfig = {
  enabled: boolean
  template: string
  options: WhatsAppMessageOption[]
}

export type WhatsAppConfig = {
  companyId: string
  turno_confirmacion: WhatsAppMessageConfig
  turno_recordatorio: WhatsAppMessageConfig
  clase_recordatorio: WhatsAppMessageConfig
  updatedAt?: string
}

type ConfigKey = 'turno_confirmacion' | 'turno_recordatorio' | 'clase_recordatorio'

const CONFIG_KEYS: ConfigKey[] = ['turno_confirmacion', 'turno_recordatorio', 'clase_recordatorio']

export const DEFAULT_CONFIG: Record<ConfigKey, WhatsAppMessageConfig> = {
  turno_confirmacion: {
    enabled: false,
    template:
      'Hola {nombre}.\n\n' +
      'Te confirmamos la asignación de tu turno:\n\n' +
      '👷 Cargo: {cargo}\n' +
      '📅 Fecha: {fecha}\n' +
      '🕐 Hora: {hora}\n' +
      '📍 Lugar: {ubicacion}\n' +
      '🗺️ Ubicación: {mapa}\n\n' +
      'LINK DE INGRESO Y SALIDA:\n{link}\n\n' +
      'Por favor confirma la recepción de esta información.',
    options: [
      { id: 'confirmo', label: 'Confirmo' },
      { id: 'no_puedo', label: 'No puedo asistir' },
      { id: 'ayuda', label: 'Necesito ayuda' },
    ],
  },
  turno_recordatorio: {
    enabled: false,
    template: '⏰ Recordatorio: {nombre}, tu turno comienza a las {hora} del {fecha} en {ubicacion}.',
    options: [
      { id: 'ok', label: '👍 Entendido' },
    ],
  },
  clase_recordatorio: {
    enabled: false,
    template: '📚 Recordatorio: {nombre}, tienes clase de {materia} el {fecha} a las {hora} en {ubicacion}.',
    options: [
      { id: 'asistire', label: '✅ Asistiré' },
      { id: 'no_asistire', label: '❌ No asistiré' },
    ],
  },
}

function mergeWithDefaults(doc: Record<string, unknown> | null, companyId: string): WhatsAppConfig {
  const base: WhatsAppConfig = { companyId, ...DEFAULT_CONFIG }
  if (!doc) return base
  for (const key of CONFIG_KEYS) {
    const incoming = doc[key] as Partial<WhatsAppMessageConfig> | undefined
    if (incoming) {
      base[key] = {
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : DEFAULT_CONFIG[key].enabled,
        template: typeof incoming.template === 'string' ? incoming.template : DEFAULT_CONFIG[key].template,
        options: Array.isArray(incoming.options) ? incoming.options : DEFAULT_CONFIG[key].options,
      }
    }
  }
  return base
}

whatsappConfigRouter.get('/', async (req, res) => {
  const { companyId } = req.query as Record<string, string>
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }
  try {
    const db = await getDb()
    const doc = await db.collection(COLLECTION).findOne({ companyId })
    res.json(mergeWithDefaults(doc as Record<string, unknown> | null, companyId))
  } catch (err) {
    console.error('[whatsapp-config] Error al leer:', err)
    res.status(500).json({ message: 'Error al leer la configuración de mensajes.' })
  }
})

whatsappConfigRouter.put('/', async (req, res) => {
  const body = req.body ?? {}
  const companyId = (body.companyId as string)?.trim()
  if (!companyId) { res.status(400).json({ message: 'companyId es requerido.' }); return }

  const db = await getDb()
  const existing = await db.collection(COLLECTION).findOne({ companyId }) as Record<string, unknown> | null
  const merged = mergeWithDefaults(existing, companyId)

  const setFields: Record<string, unknown> = { companyId, updatedAt: new Date().toISOString() }
  for (const key of CONFIG_KEYS) {
    const incoming = body[key] as Partial<WhatsAppMessageConfig> | undefined
    if (incoming) {
      merged[key] = {
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : merged[key].enabled,
        template: typeof incoming.template === 'string' ? incoming.template : merged[key].template,
        options: Array.isArray(incoming.options) ? incoming.options : merged[key].options,
      }
    }
    setFields[key] = merged[key]
  }

  try {
    await db.collection(COLLECTION).updateOne(
      { companyId },
      { $set: setFields },
      { upsert: true },
    )
    res.json({ message: 'Configuración de mensajes guardada.', config: merged })
  } catch (err) {
    console.error('[whatsapp-config] Error al guardar:', err)
    res.status(500).json({ message: 'Error al guardar la configuración de mensajes.' })
  }
})
