/**
 * Decisión pura del vínculo con turnos (opt-in). Separada de la capa de red/DB
 * para poder probarla (Property 4: turnos opt-in).
 *
 * Regla: el reenvío de WhatsApp a turnos se activa SOLO si:
 *   - existe `TURNOS_API_URL` a nivel de despliegue, Y
 *   - hay un `companyId`, Y
 *   - la empresa optó explícitamente (`whatsappUnified === true`).
 *
 * En cualquier otro caso NO se reenvía (operación autónoma por defecto).
 */
export function shouldForwardToTurnos(params: {
  turnosApiUrl: string | undefined | null
  companyId: string | undefined | null
  whatsappUnified: unknown
}): boolean {
  const { turnosApiUrl, companyId, whatsappUnified } = params
  if (!turnosApiUrl) return false
  if (!companyId) return false
  return whatsappUnified === true
}
