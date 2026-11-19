/**
 * Plantillas de WhatsApp creadas por la empresa (además de las predefinidas).
 * Funciones puras: sin base de datos, para poder probarlas.
 */

export type TemplateOption = { id: string; label: string }

export type CustomTemplate = {
  id: string
  name: string
  enabled: boolean
  template: string
  options: TemplateOption[]
}

export const MAX_CUSTOM_TEMPLATES = 20
export const MAX_TEMPLATE_OPTIONS = 10
const ID_RE = /^[\w-]{1,40}$/

function sanitizeOptions(raw: unknown): TemplateOption[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_TEMPLATE_OPTIONS).flatMap((o, i) => {
    if (!o || typeof o !== 'object') return []
    const label = String((o as { label?: unknown }).label ?? '').trim().slice(0, 60)
    if (!label) return []
    const rawId = String((o as { id?: unknown }).id ?? '')
    return [{ id: ID_RE.test(rawId) ? rawId : `opt_${i + 1}`, label }]
  })
}

/** Limpia las plantillas que llegan del cliente: límites de tamaño, ids válidos y únicos. */
export function sanitizeCustom(raw: unknown): CustomTemplate[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.slice(0, MAX_CUSTOM_TEMPLATES).flatMap((t, i) => {
    if (!t || typeof t !== 'object') return []
    const item = t as Record<string, unknown>
    let id = String(item.id ?? '')
    if (!ID_RE.test(id) || seen.has(id)) id = `tpl_${Date.now().toString(36)}_${i}`
    seen.add(id)
    return [{
      id,
      name: String(item.name ?? '').trim().slice(0, 60) || `Plantilla ${i + 1}`,
      enabled: item.enabled !== false,
      template: String(item.template ?? '').slice(0, 2000),
      options: sanitizeOptions(item.options),
    }]
  })
}
