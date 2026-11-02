/**
 * Gestor ÚNICO de sesiones de WhatsApp Web (Baileys) para todos los dominios.
 *
 * Antes cada producto tenía su propia copia del cliente de Baileys, con
 * comportamientos de reconexión distintos. Este gestor unifica esa lógica y la
 * mejora:
 *   - Backoff creciente en la reconexión (2s→5s→10s→20s→30s).
 *   - keep-alive periódico y tiempo de conexión amplio (menos desvinculaciones).
 *   - Manejo explícito de `loggedOut` (no reconectar) y `connectionReplaced`.
 *   - Watchdog (`reconnectDroppedSessions`) y reanudación al arrancar.
 *   - Reintentos y espera de reconexión antes de cada envío.
 *
 * Cada dominio instancia su propio gestor con su configuración (canal, base de
 * datos, colección de sesión y de mensajes, variable de entorno que lo habilita
 * y persistencia de mensajes entrantes). Los nombres de colección y de base de
 * datos NO cambian: es una unificación de CÓDIGO.
 */

import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import type { Domain } from '../core/mongo.js'
import { useMongoAuthState, listSavedSessionKeys } from './auth-mongo.js'

// Logger silencioso para Baileys (evita ruido en consola y errores de logger faltante).
const waLogger = pino({ level: 'silent' })

export type ConnStatus = 'disconnected' | 'connecting' | 'qr' | 'open'

export interface SessionStatus {
  status: ConnStatus
  hasQr: boolean
  /** true si hay un código de vinculación (pairing code) pendiente. */
  hasPairingCode: boolean
  /** Código de vinculación pendiente, o null. */
  pairingCode: string | null
  error: string | null
}

export interface SessionManagerOptions {
  /** Etiqueta del canal (para logs), p. ej. 'trazabilidad' o 'turnos'. */
  channel: string
  /** Dominio de Mongo: determina la base para la sesión y los mensajes. */
  domain: Domain
  /** Variable de entorno que habilita este canal (p. ej. ENABLE_WHATSAPP_WEB). */
  envFlag: string
  /** Colección donde se persiste la sesión de Baileys. */
  authCollection: string
  /** Mensaje de error cuando el canal está desactivado. */
  disabledMessage: string
  /** Mensaje de error cuando no hay conexión abierta. */
  notConnectedMessage: string
  /** Persiste un mensaje entrante (campos específicos de cada dominio). */
  persistInbound: (msg: WAMessage, companyId: string | null) => Promise<void>
}

interface State {
  sock: WASocket | null
  status: ConnStatus
  qrDataUrl: string | null
  lastError: string | null
  starting: boolean
  /** Intentos de reconexión consecutivos (para backoff). Se resetea al abrir. */
  reconnectAttempts: number
  /** true si el usuario cerró sesión a propósito (no auto-reconectar). */
  loggedOut: boolean
  /** Código de vinculación (pairing code) pendiente, si se solicitó uno. */
  pairingCode: string | null
  /** Número (solo dígitos) para el que se solicitó el pairing code. */
  pairingPhone: string | null
}

/** Backoff creciente para reconexión (ms): 2s, 5s, 10s, 20s, 30s (tope). */
function reconnectDelay(attempts: number): number {
  const steps = [2000, 5000, 10000, 20000, 30000]
  return steps[Math.min(attempts, steps.length - 1)]
}

/** Normaliza un destino a JID de WhatsApp. Acepta número (+57...) o JID (grupo @g.us). */
export function toJid(input: string): string {
  const t = (input || '').trim()
  if (t.endsWith('@g.us') || t.endsWith('@s.whatsapp.net')) return t
  const digits = t.replace(/[^\d]/g, '')
  return `${digits}@s.whatsapp.net`
}

/**
 * Normaliza un número de teléfono a solo dígitos, en formato internacional.
 * Baileys exige el número sin `+`, espacios ni guiones (p. ej. `573001234567`).
 */
export function normalizePhoneNumber(input: string): string {
  return (input || '').replace(/[^\d]/g, '')
}

export class WhatsAppSessionManager {
  private readonly opts: SessionManagerOptions
  /**
   * Sesiones por usuario dentro de la compañía (multi-tenant).
   * Clave = `companyId::userId` (o solo `companyId` si no hay usuario, o
   * `'default'` si tampoco hay compañía).
   */
  private readonly sessions = new Map<string, State>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  /** true si el canal está habilitado por variable de entorno. */
  isEnabled(): boolean {
    return process.env[this.opts.envFlag] === 'true'
  }

  /**
   * Normaliza compañía + usuario a una clave de sesión estable.
   *
   * La sesión de WhatsApp se guarda POR USUARIO dentro de la compañía
   * (`companyId::userId`), de modo que cada persona vincula su propio número.
   * Si no se indica usuario se conserva la clave por compañía (compatibilidad
   * con las sesiones ya vinculadas a nivel empresa).
   */
  private key(companyId?: string, userId?: string): string {
    const c = (companyId ?? '').trim()
    const u = (userId ?? '').trim()
    if (c && u) return `${c}::${u}`
    return c || 'default'
  }

  /** Obtiene (o crea) el State de una compañía/usuario. */
  private state(companyId?: string, userId?: string): State {
    const key = this.key(companyId, userId)
    let st = this.sessions.get(key)
    if (!st) {
      st = { sock: null, status: 'disconnected', qrDataUrl: null, lastError: null, starting: false, reconnectAttempts: 0, loggedOut: false, pairingCode: null, pairingPhone: null }
      this.sessions.set(key, st)
    }
    return st
  }

  getStatus(companyId?: string, userId?: string): SessionStatus {
    const S = this.state(companyId, userId)
    return {
      status: S.status,
      hasQr: Boolean(S.qrDataUrl),
      hasPairingCode: Boolean(S.pairingCode),
      pairingCode: S.pairingCode,
      error: S.lastError,
    }
  }

  getQrDataUrl(companyId?: string, userId?: string): string | null {
    return this.state(companyId, userId).qrDataUrl
  }

  /** Código de vinculación pendiente de una compañía/usuario (o null). */
  getPairingCode(companyId?: string, userId?: string): string | null {
    return this.state(companyId, userId).pairingCode
  }

  /**
   * Solicita un código de vinculación (pairing code) para un número de teléfono.
   *
   * Es la alternativa al QR: el código (alfanumérico, p. ej. `ABCD-1234`) se
   * ingresa en el teléfono desde WhatsApp → Dispositivos vinculados → Vincular
   * con número de teléfono. El `phoneNumber` debe venir en formato internacional
   * y solo dígitos (p. ej. `573001234567`); aquí se normaliza por si acaso.
   */
  async requestPairingCode(
    companyId: string | undefined,
    userId: string | undefined,
    phoneNumber: string,
    customCode?: string,
  ): Promise<string> {
    if (!this.isEnabled()) throw new Error(this.opts.disabledMessage)
    const phone = normalizePhoneNumber(phoneNumber)
    if (phone.length < 8) {
      throw new Error('Número de teléfono inválido. Usa el formato internacional sin "+" (p. ej. 573001234567).')
    }

    const S = this.state(companyId, userId)
    if (S.status === 'open') {
      throw new Error('Esta sesión ya está vinculada. Desvincúlala antes de generar un nuevo código.')
    }

    // Baileys exige un socket creado (aún sin vincular) para pedir el código.
    // `start` es idempotente: reutiliza el socket si ya se había iniciado.
    if (!S.sock) await this.start(companyId, userId)
    const sock = S.sock
    if (!sock) throw new Error('No se pudo iniciar la conexión con WhatsApp. Reintenta en unos segundos.')

    // `requestPairingCode` envía un nodo por el WebSocket; si el WS aún no está
    // abierto, Baileys lanza "Connection Closed". Esperamos a que el socket esté
    // listo (señal: ya emitió el QR, es decir, el WS está abierto) antes de pedir
    // el código. Si se abre del todo, la sesión ya estaba vinculada.
    const start = Date.now()
    while (Date.now() - start < 20_000) {
      // Relee el estado real en cada vuelta (el socket puede abrirse durante la
      // espera); así refleja cambios ocurridos fuera de este flujo.
      const status = this.state(companyId, userId).status
      if (status === 'open') {
        throw new Error('Esta sesión ya está vinculada. Desvincúlala antes de generar un nuevo código.')
      }
      if (status === 'qr') break
      if (!S.sock) throw new Error('La conexión con WhatsApp se cerró. Reintenta.')
      await new Promise((r) => setTimeout(r, 300))
    }
    if (S.status !== 'qr') {
      throw new Error('WhatsApp no respondió a tiempo. Reintenta en unos segundos.')
    }

    const code = await sock.requestPairingCode(phone, customCode)
    S.pairingCode = code
    S.pairingPhone = phone
    S.lastError = null
    return code
  }

  /** Inicia (o reutiliza) la conexión con WhatsApp Web para una compañía/usuario. Idempotente. */
  async start(companyId?: string, userId?: string): Promise<void> {
    if (!this.isEnabled()) throw new Error(this.opts.disabledMessage)
    const key = this.key(companyId, userId)
    const S = this.state(companyId, userId)
    if (S.sock && (S.status === 'open' || S.status === 'connecting' || S.status === 'qr')) return
    if (S.starting) return
    S.starting = true

    try {
      const { state, saveCreds } = await useMongoAuthState(this.opts.domain, this.opts.authCollection, key)
      const { version } = await fetchLatestBaileysVersion()

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        logger: waLogger as never,
        // Keep-alive: envía un "ping" periódico para que WhatsApp no cierre la
        // conexión por inactividad (principal causa de desvinculaciones).
        keepAliveIntervalMs: 20_000,
        // Más tolerancia a redes lentas/intermitentes antes de dar por caída la
        // conexión (evita cierres prematuros que forzaban re-escanear el QR).
        connectTimeoutMs: 60_000,
        retryRequestDelayMs: 1_000,
      })
      S.sock = sock
      S.status = 'connecting'
      S.lastError = null
      S.loggedOut = false

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
          S.status = 'qr'
          QRCode.toDataURL(qr).then((url) => { S.qrDataUrl = url }).catch(() => { /* noop */ })
        }
        if (connection === 'open') {
          S.status = 'open'
          S.qrDataUrl = null
          // El código de vinculación ya se usó (o dejó de ser necesario): limpiar.
          S.pairingCode = null
          S.pairingPhone = null
          S.lastError = null
          S.reconnectAttempts = 0 // reconexión exitosa → reinicia el backoff
        }
        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
          S.status = 'disconnected'
          S.sock = null
          S.starting = false

          // loggedOut: el usuario cerró sesión desde el teléfono → NO reconectar,
          // limpiar credenciales y pedir nuevo QR.
          if (statusCode === DisconnectReason.loggedOut) {
            S.loggedOut = true
            S.lastError = 'Sesión cerrada. Vuelve a escanear el QR.'
            void this.clearSession(key)
            return
          }

          // connectionReplaced: otra instancia tomó la sesión. Reconectar en
          // bucle la pisaría una y otra vez; esperamos y reintentamos con más
          // margen, sin bucle agresivo.
          if (statusCode === DisconnectReason.connectionReplaced) {
            S.lastError = 'Conexión reemplazada por otra sesión. Reintentando…'
            S.reconnectAttempts = Math.min(S.reconnectAttempts + 1, 10)
            setTimeout(() => { if (!S.loggedOut && !S.sock) void this.start(key) }, 15_000)
            return
          }

          // Resto de cierres (red caída, restartRequired, timedOut, 515…):
          // reconexión automática con backoff creciente.
          S.reconnectAttempts = Math.min(S.reconnectAttempts + 1, 10)
          const delay = reconnectDelay(S.reconnectAttempts - 1)
          S.lastError = statusCode
            ? `Conexión cerrada (código ${statusCode}). Reconectando…`
            : 'Conexión cerrada. Reconectando…'
          setTimeout(() => { if (!S.loggedOut && !S.sock) void this.start(key) }, delay)
        }
      })

      // Guardar mensajes entrantes (delegando el detalle a cada dominio).
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const m of messages) {
          if (m.key.fromMe) continue
          try {
            await this.opts.persistInbound(m, key === 'default' ? null : key.split('::')[0])
          } catch { /* db opcional */ }
        }
      })
    } finally {
      S.starting = false
    }
  }

  /**
   * Watchdog: reconecta las sesiones que quedaron caídas y no fueron cerradas
   * por el usuario (logout). Cubre el caso de que todas las reconexiones con
   * backoff se agotaran o que el backend reiniciara con credenciales ya guardadas.
   * Se llama periódicamente desde el arranque del dominio. Falla en silencio.
   */
  async reconnectDroppedSessions(): Promise<void> {
    if (!this.isEnabled()) return
    for (const [key, S] of this.sessions) {
      if (S.loggedOut) continue
      if (S.status === 'open' || S.status === 'connecting' || S.status === 'qr') continue
      if (S.sock || S.starting) continue
      try { await this.start(key) } catch { /* reintenta en el próximo ciclo */ }
    }
  }

  /**
   * Reanuda al arrancar el backend las sesiones que ya tenían credenciales
   * guardadas en Mongo, para que WhatsApp quede activo sin esperar a que el
   * cliente abra Configuración. Falla en silencio.
   */
  async resumeSavedSessions(): Promise<void> {
    if (!this.isEnabled()) return
    try {
      const keys = await listSavedSessionKeys(this.opts.domain, this.opts.authCollection)
      for (const key of keys) {
        try { await this.start(key) } catch { /* sigue con las demás */ }
      }
    } catch { /* módulo/colección no disponible */ }
  }

  /** Devuelve el socket abierto o lanza un error claro si no lo está. */
  ensureOpen(companyId?: string, userId?: string): WASocket {
    const S = this.state(companyId, userId)
    if (!S.sock || S.status !== 'open') {
      throw new Error(this.opts.notConnectedMessage)
    }
    return S.sock
  }

  /**
   * Espera a que la conexión esté 'open' hasta `timeoutMs`. Si está reconectando
   * (tiene credenciales), intenta arrancarla. Así un envío disparado justo cuando
   * la sesión está reconectando no falla de inmediato: le da margen a recuperarse.
   */
  async waitForOpen(companyId?: string, userId?: string, timeoutMs = 12_000): Promise<WASocket> {
    const S = this.state(companyId, userId)
    if (S.sock && S.status === 'open') return S.sock
    // Si no hay socket y el usuario no cerró sesión, intenta (re)conectar.
    if (!S.sock && !S.loggedOut && !S.starting) { void this.start(companyId, userId) }
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (S.sock && S.status === 'open') return S.sock
      await new Promise((r) => setTimeout(r, 500))
    }
    return this.ensureOpen(companyId, userId) // lanza el error claro si sigue sin conectar
  }

  /**
   * Envía un mensaje con reintentos automáticos ante fallos temporales de red
   * o saturación del socket. Espera a que la conexión esté abierta (con margen
   * para reconexiones) antes de enviar.
   */
  async sendContent<T>(
    companyId: string | undefined,
    userId: string | undefined,
    to: string,
    content: Record<string, unknown>,
    options: Record<string, unknown> = {},
    retries = 2,
  ): Promise<T> {
    const sock = await this.waitForOpen(companyId, userId)
    const jid = toJid(to)

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await sock.sendMessage(jid, content as any, options as any)
        return res as unknown as T
      } catch (err) {
        const isLast = attempt === retries
        console.warn(`[whatsapp:${this.opts.channel}] Error al enviar a ${to} (intento ${attempt + 1}/${retries + 1}):`, err)
        if (isLast) throw err
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1500))
      }
    }
    throw new Error('Fallo al enviar tras reintentos')
  }

  /** Cierra la sesión y borra las credenciales de una compañía/usuario (fuerza nuevo QR). */
  async clearSession(companyId?: string, userId?: string): Promise<void> {
    const key = this.key(companyId, userId)
    const S = this.state(companyId, userId)
    try { await S.sock?.logout() } catch { /* noop */ }
    S.sock = null
    S.status = 'disconnected'
    S.qrDataUrl = null
    S.pairingCode = null
    S.pairingPhone = null
    S.lastError = null
    try {
      const { clear } = await useMongoAuthState(this.opts.domain, this.opts.authCollection, key)
      await clear()
    } catch { /* noop */ }
  }
}
