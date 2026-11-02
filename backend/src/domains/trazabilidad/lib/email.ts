import nodemailer from 'nodemailer'

/**
 * Configura el transporte SMTP a partir de variables de entorno.
 * Si no hay SMTP configurado, devuelve null y el envío se omite.
 */
function createTransporter() {
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT ?? 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) return null

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

export type OperationEmailData = {
  trackingCode: string
  operationType: string
  vehiclePlate?: string
  operatorName: string
  createdAt?: string
  completedAt?: string
  photos: Array<{ driveUrl?: string; comment?: string; stepName?: string; mediaType?: 'image' | 'audio' | 'document'; fileName?: string; mimeType?: string }>
  products: Array<{
    productCode: string
    labelData?: { descripcion?: string }
    photos: Array<{ driveUrl?: string; comment?: string }>
  }>
}

type EmailAttachment = { filename: string; content: string } // content = base64

function buildOperationHtml(op: OperationEmailData): string {
  const fmt = (iso?: string) =>
    iso ? new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : ''
  const inicio = fmt(op.createdAt)
  const fin = op.completedAt ? fmt(op.completedAt) : ''

  const items = (op.photos ?? []).filter((p) => p.driveUrl && /^https?:\/\//.test(p.driveUrl))

  // Solo imágenes se incrustan como <img>.
  const photoCards = items
    .filter((p) => !p.mediaType || p.mediaType === 'image')
    .map((p) => {
      const caption = (p.comment ?? p.stepName ?? '').trim()
      return `<div style="margin-bottom:12px"><img src="${p.driveUrl}" alt="foto" style="max-width:100%;border-radius:8px" />${caption ? `<p style="margin:4px 0 0;font-size:13px;color:#555">${caption}</p>` : ''}</div>`
    })
    .join('')

  // Audios y documentos: se listan como adjuntos con enlace de descarga.
  const fileRows = items
    .filter((p) => p.mediaType === 'audio' || p.mediaType === 'document')
    .map((p) => {
      const icon = p.mediaType === 'audio' ? '🎤' : '📄'
      const name = p.fileName || (p.comment ?? '').trim() || (p.mediaType === 'audio' ? 'Audio' : 'Documento')
      return `<li style="margin:4px 0"><a href="${p.driveUrl}" style="color:#4f46e5;text-decoration:none">${icon} ${name}</a></li>`
    })
    .join('')
  const filesBlock = fileRows ? `<hr/><h3>Adjuntos</h3><ul style="padding-left:18px;margin:6px 0">${fileRows}</ul>` : ''

  const productCards = (op.products ?? [])
    .map((prod) => {
      const sendable = (prod.photos ?? []).filter((p) => p.driveUrl && /^https?:\/\//.test(p.driveUrl))
      if (sendable.length === 0) return ''
      const desc = prod.labelData?.descripcion ? `<p style="margin:2px 0;font-size:13px;color:#666">${prod.labelData.descripcion}</p>` : ''
      const obsList = [...new Set(sendable.map((p) => (p.comment ?? '').trim()).filter(Boolean))]
      const obs = obsList.length ? `<p style="margin:4px 0;font-size:13px;color:#555">📝 ${obsList.join(' · ')}</p>` : ''
      const imgs = sendable.map((p) => `<img src="${p.driveUrl}" alt="${prod.productCode}" style="max-width:48%;border-radius:8px;margin:2px" />`).join('')
      return `<div style="margin-bottom:16px;padding:12px;background:#f9f9f9;border-radius:8px"><h4 style="margin:0 0 4px">📦 ${prod.productCode}</h4>${desc}${obs}<div style="display:flex;flex-wrap:wrap">${imgs}</div></div>`
    })
    .filter(Boolean)
    .join('')

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      <h2 style="border-bottom:2px solid #4f46e5;padding-bottom:8px">📋 Registro ${op.trackingCode}</h2>
      <p style="margin:4px 0"><strong>Tipo:</strong> ${op.operationType}${op.vehiclePlate ? ` · ${op.vehiclePlate}` : ''}</p>
      <p style="margin:4px 0"><strong>Operador:</strong> ${op.operatorName}</p>
      <p style="margin:4px 0"><strong>Inicio:</strong> ${inicio}${fin ? ` &nbsp; <strong>Finalizado:</strong> ${fin}` : ''}</p>
      ${photoCards ? `<hr/><h3>Fotos generales</h3>${photoCards}` : ''}
      ${productCards ? `<hr/><h3>Productos</h3>${productCards}` : ''}
      ${filesBlock}
      <hr/><p style="font-size:12px;color:#999;text-align:center">Enviado desde Ommex Tracer</p>
    </div>
  `
}

/**
 * Envía un correo por la API HTTP de Resend (puerto 443). Funciona en entornos
 * donde el SMTP saliente está bloqueado (p. ej. Render free).
 * Acepta varios destinatarios separados por coma.
 */
/**
 * Descarga los audios y documentos del registro y los devuelve como adjuntos
 * (base64) para enviarlos como ARCHIVOS en el correo. Omite los que fallen.
 */
async function collectAttachments(op: OperationEmailData): Promise<EmailAttachment[]> {
  const files = (op.photos ?? []).filter(
    (p) => (p.mediaType === 'audio' || p.mediaType === 'document') && p.driveUrl && /^https?:\/\//.test(p.driveUrl),
  )
  const out: EmailAttachment[] = []
  for (const f of files) {
    try {
      const r = await fetch(f.driveUrl as string)
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      // Límite defensivo por adjunto (~25MB) para no exceder límites del proveedor.
      if (buf.length > 25 * 1024 * 1024) continue
      const urlName = (f.driveUrl as string).split('/').pop()?.split('?')[0] || ''
      const filename = f.fileName || urlName || (f.mediaType === 'audio' ? 'audio' : 'documento')
      out.push({ filename, content: buf.toString('base64') })
    } catch { /* omite el adjunto que falle */ }
  }
  return out
}

async function sendWithResend(to: string, subject: string, html: string, text: string, attachments: EmailAttachment[]): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return false
  const from = process.env.RESEND_FROM ?? process.env.SMTP_FROM ?? 'Klock <onboarding@resend.dev>'
  const recipients = to.split(',').map((s) => s.trim()).filter(Boolean)
  if (recipients.length === 0) return false

  const body: Record<string, unknown> = { from, to: recipients, subject, html, text }
  if (attachments.length > 0) body.attachments = attachments

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Resend respondió ${res.status}: ${detail.slice(0, 300)}`)
  }
  return true
}

/**
 * Envía un registro completo por correo electrónico.
 * Prioriza Resend (API HTTP). Si no hay RESEND_API_KEY, cae a SMTP.
 * @returns true si se envió, false si no hay ningún proveedor configurado.
 */
export async function sendOperationEmail(to: string, op: OperationEmailData): Promise<boolean> {
  const subject = `Registro ${op.trackingCode} — ${op.operationType}${op.vehiclePlate ? ` · ${op.vehiclePlate}` : ''}`
  const html = buildOperationHtml(op)
  const text = `Registro ${op.trackingCode}\nTipo: ${op.operationType}\nOperador: ${op.operatorName}`

  // Audios y documentos se envían como ARCHIVOS adjuntos.
  const attachments = await collectAttachments(op)

  // 1. Resend (recomendado; funciona aunque el SMTP saliente esté bloqueado).
  if (process.env.RESEND_API_KEY) {
    return await sendWithResend(to, subject, html, text, attachments)
  }

  // 2. Fallback a SMTP (nodemailer).
  const transporter = createTransporter()
  if (!transporter) return false
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64') })),
  })
  return true
}
