/**
 * Rutas de WhatsApp Web (Baileys, vía QR). Módulo OPCIONAL y NO oficial.
 *
 * Solo se montan si ENABLE_WHATSAPP_WEB=true. Advertencia: automatizar WhatsApp
 * Web viola los TOS de WhatsApp y el número puede ser baneado.
 *
 *  - GET  /api/whatsapp-web/status  → estado de conexión
 *  - GET  /api/whatsapp-web/qr      → QR (image/png) para escanear
 *  - POST /api/whatsapp-web/start   → inicia la conexión
 *  - POST /api/whatsapp-web/pairing-code → genera código de vinculación por número
 *  - POST /api/whatsapp-web/send    → envía texto o imagen a número o grupo
 *  - POST /api/whatsapp-web/logout  → cierra sesión y borra credenciales
 */

import { Router } from 'express'
import { getDb } from '../lib/mongodb.js'
import {
  startWhatsAppWeb, getStatus, getQrDataUrl, requestPairingCode, sendText, sendImage, sendAlbum, sendImageFromGitHub,
  listGroups, resolveGroupInvite, clearSession, toJid, sendAudio, sendDocument,
} from '../lib/whatsapp-web.js'
import { isGitHubConfigured } from '../lib/github-storage.js'
import { shouldForwardToTurnos } from '../lib/turnos-link.js'

export const whatsappWebRouter = Router()

const COLLECTION = 'whatsapp_messages'

/**
 * Guarda anti-duplicados de envíos por WhatsApp.
 *
 * Un envío (foto/álbum/registro) NO es idempotente: si el cliente reintenta
 * —o el usuario hace doble clic, o la red reenvía la petición— mientras el
 * servidor sigue enviando, las fotos se DUPLICAN en el mismo chat. Esta guarda
 * deduplica por clave lógica: mientras un envío igual está en curso se devuelve
 * ese mismo resultado (sin reenviar) y, durante una ventana corta posterior, un
 * segundo intento idéntico tampoco vuelve a enviar.
 */
const inFlightSends = new Map<string, Promise<unknown>>()
const recentSends = new Map<string, { at: number; data: unknown }>()
const DEDUPE_WINDOW_MS = 12_000

function pruneRecentSends(): void {
  const now = Date.now()
  for (const [k, v] of recentSends) {
    if (now - v.at > DEDUPE_WINDOW_MS) recentSends.delete(k)
  }
}

/** Ejecuta un envío una sola vez por clave; devuelve el resultado ya producido. */
async function sendOnce<T>(key: string, run: () => Promise<T>): Promise<{ data: T; deduped: boolean }> {
  pruneRecentSends()
  const recent = recentSends.get(key)
  if (recent) return { data: recent.data as T, deduped: true }
  const running = inFlightSends.get(key)
  if (running) return { data: (await running) as T, deduped: true }
  const started = run()
  inFlightSends.set(key, started)
  try {
    const data = await started
    recentSends.set(key, { at: Date.now(), data })
    return { data, deduped: false }
  } finally {
    inFlightSends.delete(key)
  }
}

/**
 * Usuario dueño de la sesión de WhatsApp. La vinculación es POR USUARIO dentro
 * de la compañía: se toma del usuario autenticado (`req.session.user`, inyectado
 * por requireToken) y, si el cliente envía `userId` explícito, este tiene
 * prioridad. Sin usuario se conserva la sesión a nivel compañía.
 */
function reqUserId(req: { body?: any; query?: any; session?: { user?: string } }): string | undefined {
  return (req.body?.userId as string) || (req.query?.userId as string) || req.session?.user || undefined
}

const TURNOS_API_URL = (process.env.TURNOS_API_URL || '').replace(/\/$/, '')

async function isUnifiedMode(companyId?: string): Promise<boolean> {
  // Corte rápido sin tocar la DB: sin TURNOS_API_URL o sin companyId, jamás reenvía.
  if (!shouldForwardToTurnos({ turnosApiUrl: TURNOS_API_URL, companyId, whatsappUnified: true })) return false
  try {
    const doc = await getDb().collection('company_settings').findOne({ companyId })
    return shouldForwardToTurnos({ turnosApiUrl: TURNOS_API_URL, companyId, whatsappUnified: doc?.whatsappUnified })
  } catch {
    return false
  }
}

async function forwardToTurnos(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  query?: Record<string, string | undefined>,
): Promise<{ status: number; data: any }> {
  const url = new URL(`${TURNOS_API_URL}/whatsapp-turnos${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v)
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

// Caché corta del valor efectivo de `whatsappUnified` por empresa. Tiene TTL
// para que un cambio del ROOT (vincular/desvincular turnos) surta efecto sin
// necesidad de reiniciar ni de hacer logout.
const UNIFIED_TTL_MS = 30 * 1000
let unifiedCache: Record<string, { value: boolean; at: number }> = {}

/**
 * True SOLO si la empresa optó por el vínculo con turnos (`whatsappUnified===true`)
 * Y existe `TURNOS_API_URL`. Por defecto NO reenvía (Req 7.1, 7.3, 7.5; Property 4).
 */
async function isUnified(companyId?: string): Promise<boolean> {
  if (!companyId || !TURNOS_API_URL) return false
  const hit = unifiedCache[companyId]
  if (hit && Date.now() - hit.at < UNIFIED_TTL_MS) return hit.value
  const v = await isUnifiedMode(companyId)
  unifiedCache[companyId] = { value: v, at: Date.now() }
  return v
}

/**
 * Estado del vínculo con turnos para una empresa (para exponerlo en settings/
 * mfe). Es `false` si no hay `TURNOS_API_URL` o si la empresa no optó (Req 7.4).
 */
export async function isTurnosLinked(companyId?: string): Promise<boolean> {
  return isUnifiedMode(companyId)
}

export function resetUnifiedCache() { unifiedCache = {} }

async function uSendText(to: string, text: string, companyId?: string, userId?: string): Promise<{ id: string | null }> {
  if (await isUnified(companyId)) {
    const r = await forwardToTurnos('/send-text', 'POST', { to, text, companyId, userId })
    if (r.status >= 400) throw new Error(r.data?.message || `Error ${r.status}`)
    return { id: r.data?.id ?? null }
  }
  return sendText(to, text, companyId, userId)
}

async function uSendImage(to: string, imageUrl: string, caption?: string, companyId?: string, userId?: string): Promise<{ id: string | null }> {
  if (await isUnified(companyId)) {
    const r = await forwardToTurnos('/send-image', 'POST', { to, imageUrl, caption, companyId, userId })
    if (r.status >= 400) throw new Error(r.data?.message || `Error ${r.status}`)
    return { id: r.data?.id ?? null }
  }
  return sendImage(to, imageUrl, caption, companyId, userId)
}

async function uSendAlbum(to: string, urls: string[], caption?: string, companyId?: string, userId?: string): Promise<{ id: string | null; count: number }> {
  if (await isUnified(companyId)) {
    const r = await forwardToTurnos('/send-album', 'POST', {
      to,
      images: urls.map((imageUrl) => ({ imageUrl })),
      caption,
      captionPosition: 'last',
      companyId,
      userId,
    })
    if (r.status >= 400) throw new Error(r.data?.message || `Error ${r.status}`)
    return { id: r.data?.id ?? null, count: r.data?.count ?? urls.length }
  }
  return sendAlbum(to, urls, caption, companyId, userId)
}

async function uSendAudio(to: string, audioUrl: string, companyId?: string, mimetype?: string, userId?: string): Promise<{ id: string | null }> {
  if (await isUnified(companyId)) {
    const r = await forwardToTurnos('/send-audio', 'POST', { to, audioUrl, mimetype, companyId, userId })
    if (r.status >= 400) throw new Error(r.data?.message || `Error ${r.status}`)
    return { id: r.data?.id ?? null }
  }
  return sendAudio(to, audioUrl, companyId, mimetype, userId)
}

async function uSendDocument(
  to: string,
  docUrl: string,
  opts: { fileName?: string; caption?: string; mimetype?: string } = {},
  companyId?: string,
  userId?: string,
): Promise<{ id: string | null }> {
  if (await isUnified(companyId)) {
    const r = await forwardToTurnos('/send-document', 'POST', {
      to,
      documentUrl: docUrl,
      fileName: opts.fileName,
      caption: opts.caption,
      mimetype: opts.mimetype,
      companyId,
      userId,
    })
    if (r.status >= 400) throw new Error(r.data?.message || `Error ${r.status}`)
    return { id: r.data?.id ?? null }
  }
  return sendDocument(to, docUrl, opts, companyId, userId)
}

whatsappWebRouter.get('/status', async (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/status', 'GET', undefined, companyId ? { companyId, userId } : undefined)
    return res.status(r.status).json(r.data)
  }
  res.json(getStatus(companyId, userId))
})

/** Inicia la conexión (si no está activa) y devuelve el estado. */
whatsappWebRouter.post('/start', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/start', 'POST', { companyId, userId })
    return res.status(r.status).json(r.data)
  }
  try {
    await startWhatsAppWeb(companyId, userId)
    res.json(getStatus(companyId, userId))
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo iniciar WhatsApp Web.' })
  }
})

/**
 * Devuelve el QR actual. Si aún no hay socket, intenta iniciar y pide reintentar.
 * Formatos: por defecto imagen PNG; con ?format=json devuelve { qr } (data URL).
 */
whatsappWebRouter.get('/qr', async (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/qr', 'GET', undefined, { companyId, userId, format: req.query.format as string | undefined })
    return res.status(r.status).json(r.data)
  }
  try {
    const st = getStatus(companyId, userId)
    if (st.status === 'disconnected') await startWhatsAppWeb(companyId, userId)

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
whatsappWebRouter.post('/pairing-code', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  const phoneNumber = (req.body?.phoneNumber as string) || ''
  if (!phoneNumber) { res.status(400).json({ message: 'Debes enviar "phoneNumber" en formato internacional (p. ej. 573001234567).' }); return }
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/pairing-code', 'POST', { phoneNumber, companyId, userId })
    return res.status(r.status).json(r.data)
  }
  try {
    const code = await requestPairingCode(companyId, userId, phoneNumber)
    res.json({ pairingCode: code, status: getStatus(companyId, userId).status })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo generar el código de vinculación.' })
  }
})

/**
 * Envía un mensaje.
 * Body: { to, text?, imageUrl?, caption?, companyId?, trackingCode? }
 * `to` puede ser un número (+57...) o un JID de grupo (xxxxx@g.us).
 */
whatsappWebRouter.post('/send', async (req, res) => {
  const { to, text, imageUrl, caption, companyId, trackingCode } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido (número o JID de grupo).' }); return }
  if (!text && !imageUrl) { res.status(400).json({ message: 'Debes enviar "text" o "imageUrl".' }); return }

  if (await isUnifiedMode(companyId)) {
    const path = imageUrl ? '/send-image' : '/send-text'
    const body = imageUrl
      ? { to, imageUrl, caption, companyId, userId }
      : { to, text, companyId, userId }
    const r = await forwardToTurnos(path, 'POST', body)
    if (r.status >= 200 && r.status < 300) {
      try {
        await getDb().collection(COLLECTION).insertOne({
          direction: 'outbound', channel: 'whatsapp-web', to: toJid(to),
          body: caption ?? text ?? null, imageUrl: imageUrl ?? null,
          messageId: r.data?.id ?? null, companyId: companyId ?? null,
          trackingCode: trackingCode ?? null, createdAt: new Date().toISOString(),
        })
      } catch { /* db opcional */ }
    }
    return res.status(r.status).json(r.data)
  }

  try {
    const result = imageUrl
      ? await sendImage(to, imageUrl, caption, companyId, userId)
      : await sendText(to, text, companyId, userId)

    try {
      await getDb().collection(COLLECTION).insertOne({
        direction: 'outbound',
        channel: 'whatsapp-web',
        to: toJid(to),
        body: caption ?? text ?? null,
        imageUrl: imageUrl ?? null,
        messageId: result.id,
        companyId: companyId ?? null,
        trackingCode: trackingCode ?? null,
        createdAt: new Date().toISOString(),
      })
    } catch { /* db opcional */ }

    res.json({ message: 'Mensaje enviado.', id: result.id })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el mensaje.' })
  }
})

/**
 * POST /api/whatsapp-web/send-github
 * Sube una imagen (base64) a GitHub y la envía por WhatsApp.
 * Body: { to, base64, caption?, path?, fileName?, companyId?, trackingCode? }
 */
whatsappWebRouter.post('/send-github', async (req, res) => {
  const { to, base64, caption, path, fileName, companyId, trackingCode } = req.body ?? {}
  const userId = reqUserId(req)
  if (!to) { res.status(400).json({ message: 'El destino "to" es requerido (número o JID de grupo).' }); return }
  if (!base64) { res.status(400).json({ message: '"base64" (imagen) es requerido.' }); return }
  if (!isGitHubConfigured()) { res.status(502).json({ message: 'GitHub no está configurado en el servidor (GITHUB_TOKEN/OWNER/REPO).' }); return }

  try {
    const result = await sendImageFromGitHub(to, base64, caption, { path, fileName }, companyId, userId)
    try {
      await getDb().collection(COLLECTION).insertOne({
        direction: 'outbound',
        channel: 'whatsapp-web',
        to: toJid(to),
        body: caption ?? null,
        imageUrl: result.rawUrl,
        messageId: result.id,
        companyId: companyId ?? null,
        trackingCode: trackingCode ?? null,
        createdAt: new Date().toISOString(),
      })
    } catch { /* db opcional */ }
    res.json({ message: 'Imagen subida a GitHub y enviada.', id: result.id, url: result.rawUrl })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo subir/enviar la imagen.' })
  }
})

/**
 * POST /api/whatsapp-web/send-operation
 * Envía un registro completo en secuencia (encabezado → por producto: info + fotos)
 * al destino configurado de la empresa (o al "to" del body).
 * Body: { trackingCode, to? }
 *
 * Las fotos ya están almacenadas (GitHub/R2); se envían por su URL. Entre
 * mensajes se intercala una pausa para reducir el riesgo de bloqueo.
 */
whatsappWebRouter.post('/send-operation', async (req, res) => {
  const { trackingCode, to: toOverride, headerFields, headerOnly } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  // Campos de cabecera a incluir en el mensaje de encabezado. Si no se envía,
  // se incluyen todos (compatibilidad). Valores: 'tipo','placa','operador','fecha'.
  const hf: string[] | null = Array.isArray(headerFields) ? headerFields.map(String) : null
  const includeField = (f: string) => !hf || hf.includes(f)
  // Si headerOnly=true, envía SOLO el encabezado (para la matriz mensaje×chat).
  const onlyHeader = headerOnly === true

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    // Re-firma las URLs de R2 (caducan a los ~7 días) para que Baileys pueda
    // descargar los bytes. Sin esto, las fotos antiguas devolvían 403 y no se
    // enviaban. Es best-effort: con base pública o sin R2, no altera nada.
    {
      const { refreshPhotoUrls } = await import('../lib/storage.js')
      if (Array.isArray(op.photos)) op.photos = await refreshPhotoUrls(op.photos as Array<{ fileId?: string; driveUrl?: string }>)
      if (Array.isArray(op.lineaBlanca)) {
        op.lineaBlanca = await Promise.all(
          (op.lineaBlanca as Array<{ photos?: Array<{ fileId?: string; driveUrl?: string }> }>).map(async (p) => ({
            ...p,
            photos: Array.isArray(p.photos) ? await refreshPhotoUrls(p.photos) : p.photos,
          })),
        )
      }
    }

    // Sesión de WhatsApp de ESTA empresa (multi-tenant).
    const companyId = (op.companyId as string | undefined) || undefined

    // Resolver destino: body > config de la empresa
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    // Un envío por (registro + destino + modo) se hace UNA sola vez, aunque el
    // cliente reintente o se pulse dos veces.
    const sendKey = `op|${trackingCode}|${to}|${onlyHeader ? 'h' : 'f'}|${(hf ?? []).join(',')}`
    const { data: result, deduped } = await sendOnce(sendKey, async () => {

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const PAUSE = 1500 // pausa entre mensajes (anti-spam)

    type Photo = { driveUrl?: string; fileId?: string; comment?: string; stepName?: string; timestamp?: string; mediaType?: 'image' | 'audio' | 'document'; fileName?: string; mimeType?: string }
    const hasUrl = (ph: Photo) => {
      const u = ph.driveUrl
      return Boolean(u && u !== 'pending-verification' && /^https?:\/\//.test(u))
    }
    // Sólo las imágenes van por el flujo de foto/álbum.
    const isSendable = (ph: Photo) => hasUrl(ph) && (!ph.mediaType || ph.mediaType === 'image')
    // Una nota es un mensaje de solo texto (sin imagen) con comentario.
    const isNote = (ph: Photo) => !hasUrl(ph) && Boolean((ph.comment ?? '').trim())

    // Fechas en hora de Colombia (el servidor corre en UTC).
    const fmt = (iso?: string) =>
      iso ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : ''
    const inicio = fmt(op.createdAt as string)
    const fin = op.completedAt ? fmt(op.completedAt as string) : ''

    let sent = 0
    let failedParts = 0
    const noteFailure = (label: string, err: unknown) => {
      failedParts++
      console.warn(`[whatsapp-web] ${label}:`, err instanceof Error ? err.message : err)
    }

    // 1. Encabezado — se arma con solo los campos seleccionados por el usuario.
    const headerLines: string[] = [`📋 *Registro ${op.trackingCode}*`]
    const tipoLinea = [
      includeField('tipo') ? String(op.operationType) : '',
      includeField('placa') && op.vehiclePlate ? String(op.vehiclePlate) : '',
    ].filter(Boolean).join(' · ')
    if (tipoLinea) headerLines.push(tipoLinea)
    if (includeField('operador')) headerLines.push(`👤 ${op.operatorName}`)
    if (includeField('fecha')) {
      headerLines.push(fin ? `🕒 Inicio: ${inicio}\n✅ Finalizado: ${fin}` : `🕒 ${inicio}`)
    }
    // Fallback: si se deseleccionaron todos los campos, incluye al menos el
    // operador para que el encabezado no quede solo con el código.
    if (headerLines.length === 1) headerLines.push(`👤 ${op.operatorName}`)
    try {
      await uSendText(to, headerLines.join('\n'), companyId, userId)
      sent++
      await delay(PAUSE)
    } catch (err) {
      noteFailure('No se pudo enviar el encabezado del registro', err)
    }

    // Si solo se pidió el encabezado, termina aquí (matriz mensaje×chat).
    if (onlyHeader) {
      return { message: 'Encabezado enviado.', to, sent }
    }

    // 2. Fotos generales y NOTAS de texto, en el orden del registro.
    //    Las fotos tomadas juntas (mismo groupId) se envían como UN solo álbum.
    const generalItems = (op.photos as Array<Photo & { groupId?: string }>) ?? []
    let i = 0
    while (i < generalItems.length) {
      const item = generalItems[i]

      if (isNote(item)) {
        // Mensaje escrito del registro (nota de solo texto).
        const hora = item.timestamp ? fmt(item.timestamp) : ''
        const txt = hora ? `📝 ${item.comment}\n🕒 ${hora}` : `📝 ${item.comment}`
        try {
          await uSendText(to, txt, companyId, userId)
          sent++
          await delay(PAUSE)
        } catch (err) {
          noteFailure(`No se pudo enviar una nota del registro`, err)
        }
        i++
        continue
      }

      // Audio: enviar como nota de voz, no como imagen.
      if (item.mediaType === 'audio' && hasUrl(item)) {
        try { await uSendAudio(to, item.driveUrl as string, companyId, item.mimeType, userId) ; sent++ } catch (err) { noteFailure('No se pudo enviar un audio del registro', err) }
        await delay(PAUSE)
        i++
        continue
      }

      // Documento: enviar como archivo, no como imagen.
      if (item.mediaType === 'document' && hasUrl(item)) {
        try {
          await uSendDocument(to, item.driveUrl as string, { fileName: item.fileName, caption: item.comment, mimetype: item.mimeType }, companyId, userId)
          sent++
        } catch (err) { noteFailure('No se pudo enviar un documento del registro', err) }
        await delay(PAUSE)
        i++
        continue
      }

      if (!isSendable(item)) { i++; continue }

      // Agrupar consecutivos con el mismo groupId (si lo tienen) en un álbum.
      const gid = item.groupId
      const group: Array<Photo & { groupId?: string }> = [item]
      if (gid) {
        let j = i + 1
        while (j < generalItems.length && generalItems[j].groupId === gid && isSendable(generalItems[j])) {
          group.push(generalItems[j]); j++
        }
      }

      if (group.length > 1) {
        // Caption: el comentario de la primera foto del grupo (si hay).
        const caption = (group[0].comment ?? '').trim() || undefined
        const urls = group.map((p) => p.driveUrl as string)
        try {
          const r = await uSendAlbum(to, urls, caption, companyId, userId)
          sent += r.count
        } catch (err) {
          noteFailure('No se pudo enviar un grupo de fotos del registro', err)
        }
        i += group.length
      } else {
        // Solo el comentario real del usuario; NO el stepName ("Registro
        // fotográfico") que no debe enviarse como texto.
        const cap = (item.comment ?? '').trim() || undefined
        try {
          await uSendImage(to, item.driveUrl as string, cap, companyId, userId)
          sent++
        } catch (err) {
          noteFailure('No se pudo enviar una foto del registro', err)
        }
        i++
      }
      await delay(PAUSE)
    }

    // 3. Por cada producto: enviar sus fotos como un ÁLBUM (galería agrupada)
    //    con el título del producto y las observaciones como texto único al final.
    const products = (op.lineaBlanca as Array<{ productCode: string; labelData?: { descripcion?: string }; photos: Photo[] }>) ?? []
    for (const prod of products) {
      // Dedupe por URL dentro del envío del producto.
      const seenProdUrls = new Set<string>()
      const sendable = (prod.photos ?? []).filter((p) => {
        if (!isSendable(p)) return false
        const u = p.driveUrl as string
        if (seenProdUrls.has(u)) return false
        seenProdUrls.add(u)
        return true
      })
      if (sendable.length === 0) continue

      const desc = prod.labelData?.descripcion ? `\n${prod.labelData.descripcion}` : ''
      // Observaciones: junta los comentarios distintos de las fotos del producto.
      const obsList = [...new Set(sendable.map((p) => (p.comment ?? '').trim()).filter(Boolean))]
      const obs = obsList.length ? `\n📝 ${obsList.join(' · ')}` : ''
      // Línea 1: código en negrita. Línea 2: descripción (con Cliente/Placa de la
      // DATA). Línea 3 (si hay): observaciones.
      const caption = `*${prod.productCode}*${desc}${obs}`

      const urls = sendable.map((p) => p.driveUrl as string)
      try {
        const r = await uSendAlbum(to, urls, caption, companyId, userId)
        sent += r.count
      } catch (err) {
        noteFailure(`No se pudo enviar el producto ${prod.productCode}`, err)
      }
      await delay(PAUSE)
    }

    if (sent === 0 && failedParts > 0) {
      throw new Error('No se pudo completar el envío del registro por WhatsApp.')
    }
    return failedParts > 0
      ? {
          message: `Registro enviado parcialmente a WhatsApp (${sent} mensaje(s)).`,
          to,
          sent,
          partial: true,
          failedParts,
        }
      : { message: `Registro enviado a WhatsApp (${sent} mensaje(s)).`, to, sent, partial: false, failedParts: 0 }
    })
    res.json({ ...result, ...(deduped ? { deduped: true } : {}) })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar operación:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el registro.' })
  }
})

/**
 * POST /api/whatsapp-web/send-product
 * Envía UN producto (sus fotos como álbum + título/observaciones) al destino.
 * Body: { trackingCode, productCode, to? }
 */
whatsappWebRouter.post('/send-product', async (req, res) => {
  const { trackingCode, productCode, to: toOverride } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode || !productCode) { res.status(400).json({ message: 'trackingCode y productCode son requeridos.' }); return }

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = (op.companyId as string | undefined) || undefined
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    type Photo = { driveUrl?: string; comment?: string }
    const isSendable = (ph: Photo) => {
      const u = ph.driveUrl
      return Boolean(u && u !== 'pending-verification' && /^https?:\/\//.test(u))
    }

    const products = (op.lineaBlanca as Array<{ productCode: string; labelData?: { descripcion?: string }; photos: Photo[] }>) ?? []
    const prod = products.find((p) => p.productCode === productCode)
    if (!prod) { res.status(404).json({ message: `Producto "${productCode}" no encontrado.` }); return }

    // Dedupe por URL dentro del envío: evita reenviar la misma imagen dos veces
    // si por datos heredados hubiera fotos con el mismo driveUrl.
    const seenUrls = new Set<string>()
    const sendable = (prod.photos ?? []).filter((p) => {
      if (!isSendable(p)) return false
      const u = p.driveUrl as string
      if (seenUrls.has(u)) return false
      seenUrls.add(u)
      return true
    })
    if (sendable.length === 0) { res.status(400).json({ message: 'El producto no tiene fotos subidas para enviar.' }); return }

    const desc = prod.labelData?.descripcion ? `\n${prod.labelData.descripcion}` : ''
    const obsList = [...new Set(sendable.map((p) => (p.comment ?? '').trim()).filter(Boolean))]
    const obs = obsList.length ? `\n📝 ${obsList.join(' · ')}` : ''
    // Línea 1: código en negrita. Línea 2: descripción (con Cliente/Placa de la
    // DATA). Línea 3 (si hay): observaciones.
    const caption = `*${prod.productCode}*${desc}${obs}`

    // Un producto (registro + destino) se envía UNA sola vez por ventana corta.
    const { data: result, deduped } = await sendOnce(`prod|${trackingCode}|${to}|${productCode}`, async () => {
      const r = await uSendAlbum(to, sendable.map((p) => p.driveUrl as string), caption, companyId, userId)
      return { message: `Producto ${productCode} enviado (${r.count} foto(s)).`, to, sent: r.count }
    })
    res.json({ ...result, ...(deduped ? { deduped: true } : {}) })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar producto:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el producto.' })
  }
})

/**
 * POST /api/whatsapp-web/send-photo-group
 * Envía un grupo de fotos (álbum) de la operación al destino configurado.
 * Body: { trackingCode, photoIndices: number[], to? }
 */
whatsappWebRouter.post('/send-photo-group', async (req, res) => {
  const { trackingCode, photoIndices, to: toOverride } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode || !Array.isArray(photoIndices) || photoIndices.length === 0) {
    res.status(400).json({ message: 'trackingCode y photoIndices (array) son requeridos.' }); return
  }

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = (op.companyId as string | undefined) || undefined
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    type Photo = { driveUrl?: string; comment?: string; stepName?: string }
    const photos = (op.photos as Photo[]) ?? []
    // Dedupe por índice y por URL dentro del envío (una imagen → un solo envío).
    const seenIdx = new Set<number>()
    const seenUrls = new Set<string>()
    const sendable = (photoIndices as number[])
      .filter((idx) => { if (seenIdx.has(idx)) return false; seenIdx.add(idx); return true })
      .map((idx) => photos[idx])
      .filter((p) => {
        if (!(p && p.driveUrl && p.driveUrl !== 'pending-verification' && /^https?:\/\//.test(p.driveUrl ?? ''))) return false
        const u = p.driveUrl as string
        if (seenUrls.has(u)) return false
        seenUrls.add(u)
        return true
      })
    if (sendable.length === 0) { res.status(400).json({ message: 'Ninguna de las fotos seleccionadas está disponible para envío.' }); return }

    // Caption = solo el comentario real del usuario (si alguna foto lo tiene).
    // NO se usa stepName ("Registro fotográfico") como texto del mensaje.
    const withComment = sendable.find((p) => (p.comment ?? '').trim())
    const captionText = (withComment?.comment ?? '').trim() || undefined
    // Clave estable: mismo registro + destino + conjunto exacto de fotos.
    const groupKey = [...sendable.map((p) => p.driveUrl as string)].join('|')
    const { data: result, deduped } = await sendOnce(`grp|${trackingCode}|${to}|${groupKey}`, async () => {
      const r = await uSendAlbum(to, sendable.map((p) => p.driveUrl as string), captionText, companyId, userId)
      return { message: `Álbum enviado (${r.count} foto(s)).`, to, sent: r.count }
    })
    res.json({ ...result, ...(deduped ? { deduped: true } : {}) })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar álbum:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el álbum.' })
  }
})

/**
 * POST /api/whatsapp-web/send-photo
 * Envía UNA foto individual de la operación (por índice) al destino configurado.
 * Body: { trackingCode, photoIndex, to? }
 */
whatsappWebRouter.post('/send-photo', async (req, res) => {
  const { trackingCode, photoIndex, to: toOverride } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode || photoIndex === undefined || photoIndex === null) {
    res.status(400).json({ message: 'trackingCode y photoIndex son requeridos.' }); return
  }
  const idx = Number(photoIndex)
  if (!Number.isFinite(idx) || idx < 0) {
    res.status(400).json({ message: 'photoIndex debe ser un número entero no negativo.' }); return
  }

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = (op.companyId as string | undefined) || undefined
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    type Photo = { driveUrl?: string; comment?: string; stepName?: string; mediaType?: string; mimeType?: string; fileName?: string }
    const photos = (op.photos as Photo[]) ?? []
    const photo = photos[idx]
    if (!photo) { res.status(404).json({ message: `No existe foto en el índice ${idx}.` }); return }

    const url = photo.driveUrl
    const isNote = (photo as { fileId?: string }).fileId === 'note' || photo.stepName === 'Nota'
    const noImage = !url || url === 'pending-verification' || !/^https?:\/\//.test(url)

    // Nota de solo texto (sin imagen) → se envía como mensaje de texto.
    if (isNote || (noImage && !photo.mediaType)) {
      const text = (photo.comment ?? '').trim()
      if (!text) { res.status(400).json({ message: 'La nota no tiene texto para enviar.' }); return }
      const r = await uSendText(to, text, companyId, userId)
      res.json({ message: 'Mensaje enviado a WhatsApp.', to, id: r.id })
      return
    }

    if (noImage) {
      res.status(400).json({ message: 'La foto aún no está disponible para envío (pendiente de subida).' }); return
    }

    // Una foto concreta (registro + destino + índice) se envía UNA sola vez.
    const { data: result, deduped } = await sendOnce(`ph|${trackingCode}|${to}|${idx}`, async () => {
      // Solo el comentario real del usuario; NO el stepName ("Registro
      // fotográfico") como texto del mensaje.
      const caption = (photo.comment ?? '').trim() || undefined

      // Audio, documento o imagen — usar el helper adecuado.
      if (photo.mediaType === 'audio') {
        const r = await uSendAudio(to, url, companyId, photo.mimeType, userId)
        return { message: 'Audio enviado a WhatsApp.', to, id: r.id }
      }
      if (photo.mediaType === 'document') {
        const r = await uSendDocument(to, url, { fileName: photo.fileName, caption, mimetype: photo.mimeType }, companyId, userId)
        return { message: 'Documento enviado a WhatsApp.', to, id: r.id }
      }
      const r = await uSendImage(to, url, caption, companyId, userId)
      return { message: 'Foto enviada a WhatsApp.', to, id: r.id }
    })
    res.json({ ...result, ...(deduped ? { deduped: true } : {}) })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar foto individual:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar la foto.' })
  }
})

/**
 * POST /api/whatsapp-web/send-audio
 * Envía un audio (nota de voz) al destino configurado de la empresa.
 * Body: { trackingCode, audioUrl, to? }
 */
whatsappWebRouter.post('/send-audio', async (req, res) => {
  const { trackingCode, audioUrl, mimetype, to: toOverride } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  if (!audioUrl) { res.status(400).json({ message: 'audioUrl es requerido.' }); return }

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = (op.companyId as string | undefined) || undefined
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    const r = await uSendAudio(to, audioUrl, companyId, mimetype, userId)
    res.json({ message: 'Audio enviado a WhatsApp.', to, id: r.id })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar audio:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el audio.' })
  }
})

/**
 * POST /api/whatsapp-web/send-document
 * Envía un documento (PDF, Excel, etc.) al destino configurado de la empresa.
 * Body: { trackingCode, documentUrl, fileName?, caption?, mimetype?, to? }
 */
whatsappWebRouter.post('/send-document', async (req, res) => {
  const { trackingCode, documentUrl, fileName, caption, mimetype, to: toOverride } = req.body ?? {}
  const userId = reqUserId(req)
  if (!trackingCode) { res.status(400).json({ message: 'trackingCode es requerido.' }); return }
  if (!documentUrl) { res.status(400).json({ message: 'documentUrl es requerido.' }); return }

  try {
    const { getOperationsCollection, getDb } = await import('../lib/mongodb.js')
    const op = await getOperationsCollection().findOne({ trackingCode })
    if (!op) { res.status(404).json({ message: 'Operación no encontrada.' }); return }

    const companyId = (op.companyId as string | undefined) || undefined
    let to = (toOverride ?? '').trim()
    if (!to && op.companyId) {
      const settings = await getDb().collection('company_settings').findOne({ companyId: op.companyId })
      to = (settings?.whatsappTo as string) ?? ''
    }
    if (!to) { res.status(400).json({ message: 'No hay destino de WhatsApp configurado para esta empresa.' }); return }

    const r = await uSendDocument(to, documentUrl, { fileName, caption, mimetype }, companyId, userId)
    res.json({ message: 'Documento enviado a WhatsApp.', to, id: r.id })
  } catch (err) {
    console.error('[whatsapp-web] Error al enviar documento:', err)
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo enviar el documento.' })
  }
})

/**
 * GET /api/whatsapp-web/groups
 * Lista los grupos (id JID + nombre) de la cuenta conectada.
 */
whatsappWebRouter.get('/groups', async (req, res) => {
  const companyId = (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/groups', 'GET', undefined, companyId ? { companyId, userId } : undefined)
    return res.status(r.status).json(r.data)
  }
  try {
    const groups = await listGroups(companyId, userId)
    res.json({ groups })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudieron listar los grupos.' })
  }
})

/**
 * GET /api/whatsapp-web/resolve-invite?link=...
 * Devuelve el JID de un grupo a partir de su enlace/código de invitación.
 */
whatsappWebRouter.get('/resolve-invite', async (req, res) => {
  const link = (req.query.link as string) ?? ''
  const companyId = (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  if (!link) { res.status(400).json({ message: 'Parámetro "link" requerido.' }); return }
  try {
    const group = await resolveGroupInvite(link, companyId, userId)
    res.json(group)
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'No se pudo resolver el enlace del grupo.' })
  }
})

whatsappWebRouter.post('/logout', async (req, res) => {
  const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || undefined
  const userId = reqUserId(req)
  resetUnifiedCache()
  if (await isUnifiedMode(companyId)) {
    const r = await forwardToTurnos('/logout', 'POST', { companyId, userId })
    return res.status(r.status).json(r.data)
  }
  try {
    await clearSession(companyId, userId)
    res.json({ message: 'Sesión cerrada. Escanea el QR para volver a conectar.' })
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'No se pudo cerrar la sesión.' })
  }
})
