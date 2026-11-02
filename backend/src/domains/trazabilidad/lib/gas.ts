/**
 * Cliente para el WebApp de Google Apps Script.
 *
 * Apps Script responde a los POST con un 302 hacia script.googleusercontent.com.
 * `fetch` (undici) con redirect:'follow' reconvierte el POST a GET al seguir ese
 * 302 y recupera el JSON final, que es el comportamiento correcto.
 *
 * Nota operativa: Google puede responder temporalmente con una página de
 * "tráfico inusual" (HTTP 403 / HTML) si se hacen demasiadas peticiones en
 * poco tiempo desde la misma IP. En ese caso parseJson lanzará un error claro
 * y la ruta lo reporta como 502; es transitorio y se resuelve solo.
 */

export interface GasResponse {
  status?: string
  message?: string
  [key: string]: unknown
}

export async function callGas(
  gasUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<GasResponse> {
  if (!gasUrl) throw new Error('GAS_WEBHOOK_URL no configurado.')

  const resp = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await resp.text()
  try {
    return JSON.parse(text) as GasResponse
  } catch {
    // Respuesta no-JSON: normalmente la página de protección de Google.
    throw new Error(
      resp.status === 403 || /unusual|ppConfig|DOCTYPE/.test(text.slice(0, 60))
        ? 'Google Apps Script rechazó temporalmente la petición (tráfico inusual). Reintenta en unos minutos.'
        : 'Respuesta inválida de Google Apps Script.',
    )
  }
}
