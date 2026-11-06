/**
 * Cliente de WhatsApp Web vía Baileys (NO oficial — conexión por QR) para el
 * dominio TRAZABILIDAD.
 *
 * ⚠️ Esta vía automatiza WhatsApp Web y VIOLA los Términos de Servicio de
 * WhatsApp; el número conectado puede ser baneado. Úsese bajo responsabilidad
 * propia y preferiblemente con un número secundario.
 *
 * La CONEXIÓN ahora la gestiona el gestor ÚNICO compartido (`src/whatsapp`),
 * que aporta backoff, keep-alive y watchdog. Este archivo solo conserva las
 * firmas que consumen las rutas y aporta los envíos específicos de trazabilidad
 * (descarga robusta de imágenes, álbum, subida a GitHub).
 *
 * Está DESACTIVADO por defecto. Se activa con ENABLE_WHATSAPP_WEB=true.
 * La sesión se persiste en Mongo (colección `whatsapp_web_auth`) para
 * sobrevivir a los reinicios.
 */

import { WhatsAppSessionManager, toJid as toJidShared } from '../../../whatsapp/session-manager.js'
import { getDb } from './mongodb.js'
import { toDirectImageUrl } from './image-url.js'

const MESSAGES_COLLECTION = 'whatsapp_messages'

const manager = new WhatsAppSessionManager({
  channel: 'trazabilidad',
  domain: 'trazabilidad',
  envFlag: 'ENABLE_WHATSAPP_WEB',
  authCollection: 'whatsapp_web_auth',
  disabledMessage: 'WhatsApp Web está desactivado (define ENABLE_WHATSAPP_WEB=true).',
  notConnectedMessage: 'WhatsApp Web no está conectado para esta empresa. Escanea el QR primero en Configuración.',
  persistInbound: async (m, companyId) => {
    await getDb().collection(MESSAGES_COLLECTION).insertOne({
      direction: 'inbound',
      channel: 'whatsapp-web',
      companyId,
      from: m.key.remoteJid ?? null,
      pushName: m.pushName ?? null,
      body: m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null,
      messageId: m.key.id ?? null,
      hasMedia: Boolean(m.message?.imageMessage || m.message?.videoMessage || m.message?.documentMessage),
      createdAt: new Date().toISOString(),
    })
  },
})

export function isWhatsAppWebEnabled(): boolean {
  return manager.isEnabled()
}

export function getStatus(companyId?: string, userId?: string) {
  return manager.getStatus(companyId, userId)
}

export function getQrDataUrl(companyId?: string, userId?: string): string | null {
  return manager.getQrDataUrl(companyId, userId)
}

/** Código de vinculación (pairing code) pendiente, o null. */
export function getPairingCode(companyId?: string, userId?: string): string | null {
  return manager.getPairingCode(companyId, userId)
}

/**
 * Solicita un código de vinculación para un número (alternativa al QR).
 * `phoneNumber` en formato internacional solo dígitos (p. ej. 573001234567).
 */
export async function requestPairingCode(
  companyId: string | undefined,
  userId: string | undefined,
  phoneNumber: string,
): Promise<string> {
  return manager.requestPairingCode(companyId, userId, phoneNumber)
}

/** Inicia (o reutiliza) la conexión con WhatsApp Web para una compañía/usuario. Idempotente. */
export async function startWhatsAppWeb(companyId?: string, userId?: string): Promise<void> {
  return manager.start(companyId, userId)
}

/**
 * Watchdog: reconecta las sesiones que quedaron caídas y no fueron cerradas por
 * el usuario (logout). Se llama periódicamente desde el arranque del dominio.
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
export async function sendText(to: string, text: string, companyId?: string, userId?: string): Promise<{ id: string | null }> {
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, { text })
  return { id: res?.key?.id ?? null }
}

/**
 * Descarga una imagen a un Buffer con reintentos y validación de contenido.
 * En vez de dejar que Baileys haga el fetch interno (que falla de forma opaca
 * con ciertas URLs), traemos los bytes aquí: así validamos que sea una imagen
 * real y damos un error claro/logueable cuando no lo es.
 */
async function fetchImageBuffer(url: string, retries = 2): Promise<Buffer | null> {
  const direct = toDirectImageUrl(url)
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(direct, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (OmmexTracer)' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const buf = Buffer.from(await res.arrayBuffer())
      // Rechaza respuestas que claramente NO son imagen (HTML de login/404 de
      // Drive, páginas de error), que son las que rompían el envío.
      const looksHtml = ct.includes('text/html') || buf.slice(0, 15).toString('utf8').trim().toLowerCase().startsWith('<!doctype')
      if (looksHtml || buf.length < 100) throw new Error(`contenido no-imagen (${ct || 'desconocido'}, ${buf.length}B)`)
      return buf
    } catch (err) {
      console.warn(`[whatsapp:trazabilidad] fetch imagen falló (intento ${attempt + 1}/${retries + 1}) ${direct}:`, err instanceof Error ? err.message : err)
      if (attempt < retries) await new Promise((r) => setTimeout(r, (attempt + 1) * 1000))
    }
  }
  return null
}

/** Envía una imagen (desde Buffer o URL) a un número o grupo, con caption opcional. */
export async function sendImage(to: string, image: Buffer | string, caption?: string, companyId?: string, userId?: string): Promise<{ id: string | null }> {
  // Si es URL, descargamos los bytes nosotros (robusto) antes de enviar; si
  // falla la descarga, caemos al método anterior (Baileys hace el fetch) para
  // no perder el caso en que la URL sí sea descargable solo por Baileys.
  let img: { url: string } | Buffer
  if (typeof image === 'string') {
    const buf = await fetchImageBuffer(image)
    img = buf ?? { url: toDirectImageUrl(image) }
  } else {
    img = image
  }
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, { image: img, caption })
  return { id: res?.key?.id ?? null }
}

/** Envía un audio (desde Buffer o URL) a un número o grupo. */
export async function sendAudio(to: string, audio: Buffer | string, companyId?: string, mimetype?: string, userId?: string): Promise<{ id: string | null }> {
  const aud = typeof audio === 'string' ? { url: audio } : audio
  const m = (mimetype || '').toLowerCase()
  const url = typeof audio === 'string' ? audio : ''

  const looksOgg = m.includes('ogg') || m.includes('opus') || /\.ogg(\?|$)/i.test(url)
  const looksMp4 = m.includes('mp4') || m.includes('m4a') || /\.(m4a|mp4)(\?|$)/i.test(url)
  const looksWebm = m.includes('webm') || /\.webm(\?|$)/i.test(url)

  if (looksOgg || looksMp4) {
    const finalMime = looksMp4 ? 'audio/mp4' : 'audio/ogg; codecs=opus'
    const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, { audio: aud, mimetype: finalMime, ptt: true })
    return { id: res?.key?.id ?? null }
  }

  if (looksWebm || !looksOgg) {
    const fileName = `audio.${looksWebm ? 'webm' : 'bin'}`
    const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, {
      document: aud,
      fileName,
      mimetype: m || 'audio/webm',
      caption: '🎤 Audio',
    })
    return { id: res?.key?.id ?? null }
  }

  const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, { audio: aud, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  return { id: res?.key?.id ?? null }
}

/** Envía un documento (desde Buffer o URL) a un número o grupo, con nombre y caption opcionales. */
export async function sendDocument(
  to: string,
  document: Buffer | string,
  opts: { fileName?: string; caption?: string; mimetype?: string } = {},
  companyId?: string,
  userId?: string,
): Promise<{ id: string | null }> {
  const doc = typeof document === 'string' ? { url: document } : document
  const docMessage: Record<string, unknown> = { document: doc, fileName: opts.fileName ?? 'documento' }
  if (opts.caption) docMessage.caption = opts.caption
  if (opts.mimetype) docMessage.mimetype = opts.mimetype
  const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, docMessage)
  return { id: res?.key?.id ?? null }
}

/**
 * Álbum NATIVO de WhatsApp: primero un mensaje `albumMessage` con el número de
 * fotos esperado, y luego cada foto asociada a él (`albumParentKey` →
 * messageAssociation MEDIA_ALBUM). WhatsApp lo muestra como UNA burbuja con
 * cuadrícula y el texto debajo.
 *
 * Devuelve null si el mensaje padre falla (no se envió nada → el llamador usa
 * el envío secuencial). Si alguna foto falla después, NO se reenvía en modo
 * secuencial para no duplicar fotos: se devuelve lo que sí salió.
 */
async function sendNativeAlbum(
  to: string,
  buffers: Buffer[],
  caption: string | undefined,
  companyId?: string,
  userId?: string,
): Promise<{ id: string | null; count: number } | null> {
  let parentKey: { id?: string | null } | undefined
  try {
    const parent = await manager.sendContent<{ key: { id?: string | null } }>(companyId, userId, to, {
      album: { expectedImageCount: buffers.length },
    })
    parentKey = parent?.key
  } catch (err) {
    console.error('[whatsapp:trazabilidad] Álbum nativo: falló el mensaje padre, se usa envío secuencial:', err)
    return null
  }
  if (!parentKey) return null

  let count = 0
  for (let i = 0; i < buffers.length; i++) {
    try {
      await manager.sendContent(companyId, userId, to, {
        image: buffers[i],
        albumParentKey: parentKey,
        // El texto en la primera foto del álbum: WhatsApp lo muestra bajo la cuadrícula.
        ...(i === 0 && caption ? { caption } : {}),
      })
      count++
    } catch (err) {
      console.error(`[whatsapp:trazabilidad] Álbum nativo: fallo al enviar la foto ${i}:`, err)
    }
    if (i < buffers.length - 1) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (count === 0) throw new Error('No se pudo enviar ninguna foto del álbum. Revisa la conexión de WhatsApp.')
  return { id: parentKey.id ?? null, count }
}

/**
 * Envía varias imágenes como un ÁLBUM (agrupadas, como una galería en WhatsApp)
 * con un único texto (caption) que aparece una sola vez al final del grupo.
 *
 * WhatsApp agrupa automáticamente las imágenes enviadas en secuencia rápida.
 */
export async function sendAlbum(
  to: string,
  images: Array<string | Buffer>,
  caption?: string,
  companyId?: string,
  userId?: string,
): Promise<{ id: string | null; count: number }> {
  if (images.length === 0) return { id: null, count: 0 }

  // 0. Espera a que la conexión esté abierta (reconexión incluida) antes de
  //    enviar; si tras el margen sigue caída, lanza un error claro con guía.
  await manager.waitForOpen(companyId, userId)

  // 1. Descarga TODAS las imágenes a Buffer primero (robusto). Las que no se
  //    puedan descargar se omiten, pero no rompen el resto del álbum.
  const buffers: Buffer[] = []
  for (let i = 0; i < images.length; i++) {
    const im = images[i]
    if (typeof im === 'string') {
      const buf = await fetchImageBuffer(im)
      if (buf) buffers.push(buf)
      else console.error(`[whatsapp:trazabilidad] Imagen ${i} del álbum omitida: no se pudo descargar ${im}`)
    } else {
      buffers.push(im)
    }
  }
  if (buffers.length === 0) return { id: null, count: 0 }

  // 1b. Álbum NATIVO (opcional, WHATSAPP_NATIVE_ALBUM=true): una sola burbuja
  //     con cuadrícula 2x2, "+N" y el texto debajo. Si el mensaje padre no se
  //     puede enviar, no se envió nada y se sigue con el envío secuencial.
  if (process.env.WHATSAPP_NATIVE_ALBUM === 'true' && buffers.length >= 2) {
    const native = await sendNativeAlbum(to, buffers, caption, companyId, userId)
    if (native) return native
  }

  // 2. Envío SECUENCIAL: cada imagen como un mensaje de imagen independiente.
  //    NO se usa el "álbum nativo" de Baileys (expectedImageCount +
  //    albumParentKey): en 7.0.0-rc14 WhatsApp recibe los eventos (los marca
  //    como "N mensajes no leídos") pero NO renderiza las imágenes del álbum.
  //    Enviar imágenes normales en secuencia es fiable y WhatsApp las agrupa
  //    visualmente por sí mismo cuando llegan seguidas.
  let firstId: string | null = null
  let count = 0
  let captionSent = false
  for (let i = 0; i < buffers.length; i++) {
    // El caption va en la ÚLTIMA imagen: WhatsApp agrupa en cuadrícula las
    // imágenes seguidas sin texto y muestra el texto debajo del grupo, como un
    // álbum. Con el texto en la primera, esa foto queda suelta.
    const isLast = i === buffers.length - 1
    // La última foto lleva el texto: si falla se reintenta una vez antes de
    // dar el texto por perdido, para que el grupo y el texto queden juntos.
    const attempts = isLast && caption ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await manager.sendContent<{ key: { id: string } }>(companyId, userId, to, {
          image: buffers[i],
          ...(isLast && caption ? { caption } : {}),
        })
        if (count === 0) firstId = res?.key?.id ?? null
        if (isLast && caption) captionSent = true
        count++
        break
      } catch (err) {
        console.error(`[whatsapp:trazabilidad] Fallo al enviar imagen ${i} del grupo (intento ${attempt}/${attempts}):`, err)
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    // Pausa breve entre imágenes: suficiente para que WhatsApp las agrupe sin
    // saturar la conexión.
    if (i < buffers.length - 1) {
      const delay = buffers.length > 5 ? 400 : 600
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  // Si no se pudo enviar NINGUNA imagen (p. ej. conexión caída a mitad), es un
  // fallo real: no lo reportes como éxito con 0 fotos.
  if (count === 0) throw new Error('No se pudo enviar ninguna foto del grupo. Revisa la conexión de WhatsApp.')
  // Si la última foto falló, el texto no salió: se manda como mensaje aparte
  // para no perderlo.
  if (caption && !captionSent) {
    try {
      await manager.sendContent(companyId, userId, to, { text: caption })
    } catch (err) {
      console.error('[whatsapp:trazabilidad] No se pudo enviar el texto del álbum:', err)
    }
  }
  return { id: firstId, count }
}

/**
 * Sube una imagen a GitHub (raw.githubusercontent.com) y la envía por WhatsApp.
 * @param to      número (+57...) o JID de grupo (xxxx@g.us)
 * @param image   Buffer o base64 de la imagen
 * @param caption texto que acompaña la imagen
 * @param opts    path/fileName dentro del repo de GitHub
 */
export async function sendImageFromGitHub(
  to: string,
  image: Buffer | string,
  caption?: string,
  opts: { path?: string; fileName?: string } = {},
  companyId?: string,
  userId?: string,
): Promise<{ id: string | null; rawUrl: string }> {
  const sock = await manager.waitForOpen(companyId, userId)
  const { uploadImageToGitHub } = await import('./github-storage.js')
  const { rawUrl } = await uploadImageToGitHub(image, { path: opts.path || 'whatsapp', fileName: opts.fileName })
  const res = await sock.sendMessage(toJid(to), { image: { url: rawUrl }, caption })
  return { id: res?.key?.id ?? null, rawUrl }
}

/** Lista los grupos a los que pertenece la cuenta: { id (JID), name }. */
export async function listGroups(companyId?: string, userId?: string): Promise<Array<{ id: string; name: string }>> {
  const sock = await manager.waitForOpen(companyId, userId)
  const groups = await sock.groupFetchAllParticipating()
  return Object.values(groups).map((g) => ({ id: g.id, name: g.subject || g.id }))
}

/**
 * Resuelve un enlace/código de invitación de grupo a su JID (y nombre).
 * Acepta la URL completa (https://chat.whatsapp.com/XXXX) o solo el código.
 */
export async function resolveGroupInvite(linkOrCode: string, companyId?: string, userId?: string): Promise<{ id: string; name: string }> {
  const sock = await manager.waitForOpen(companyId, userId)
  const code = (linkOrCode || '').trim().replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').replace(/\/+$/, '')
  const meta = await sock.groupGetInviteInfo(code)
  return { id: meta.id, name: meta.subject || meta.id }
}

/** Cierra la sesión y borra las credenciales de una compañía/usuario (fuerza nuevo QR). */
export async function clearSession(companyId?: string, userId?: string): Promise<void> {
  return manager.clearSession(companyId, userId)
}
