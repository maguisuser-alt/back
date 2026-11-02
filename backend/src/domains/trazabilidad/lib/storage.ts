/**
 * Almacenamiento de imágenes en Cloudflare R2 (compatible con la API de S3).
 *
 * Reemplaza la dependencia de Google Drive para los binarios: las imágenes se
 * suben a un bucket R2 y se guarda su URL (pública o firmada) en MongoDB.
 *
 * Variables de entorno:
 *   R2_ACCOUNT_ID         - ID de cuenta de Cloudflare
 *   R2_ACCESS_KEY_ID      - Access Key del token R2
 *   R2_SECRET_ACCESS_KEY  - Secret del token R2
 *   R2_BUCKET             - Nombre del bucket
 *   R2_PUBLIC_BASE_URL    - (opcional) Base pública del bucket (dominio o r2.dev)
 *                           Si se define, las URLs devueltas son públicas y
 *                           permanentes. Si NO se define, se devuelven URLs
 *                           firmadas temporales.
 *   R2_SIGNED_URL_TTL     - (opcional) segundos de validez de la URL firmada
 *                           (default 604800 = 7 días).
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

let _client: S3Client | null = null

function getBucket(): string {
  return process.env.R2_BUCKET ?? ''
}

export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  )
}

function getClient(): S3Client {
  if (_client) return _client
  if (!isStorageConfigured()) {
    throw new Error('Almacenamiento R2 no configurado. Define R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET.')
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
  })
  return _client
}

export interface UploadResult {
  key: string
  url: string
  /** true si la URL es pública permanente; false si es firmada temporal. */
  public: boolean
}

/** Normaliza un base64 (con o sin prefijo data URL) a Buffer. */
function base64ToBuffer(base64: string): Buffer {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  return Buffer.from(clean, 'base64')
}

/**
 * Sube una imagen a R2 y devuelve su URL.
 * @param data   base64 (con/sin data URL) o Buffer
 * @param opts   contentType, prefijo de carpeta lógica y nombre opcional
 */
export async function uploadImage(
  data: string | Buffer,
  opts: { contentType?: string; keyPrefix?: string; fileName?: string } = {},
): Promise<UploadResult> {
  const client = getClient()
  const bucket = getBucket()

  const buffer = typeof data === 'string' ? base64ToBuffer(data) : data
  const contentType = opts.contentType || 'image/jpeg'
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  const safePrefix = (opts.keyPrefix || 'uploads').replace(/^\/+|\/+$/g, '')
  const name = opts.fileName ? opts.fileName.replace(/[^a-zA-Z0-9._-]/g, '_') : `${randomUUID()}.${ext}`
  const key = `${safePrefix}/${name}`

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))

  // URL pública si hay base pública; si no, URL firmada temporal.
  const publicBase = process.env.R2_PUBLIC_BASE_URL
  if (publicBase) {
    const base = publicBase.replace(/\/+$/, '')
    return { key, url: `${base}/${key}`, public: true }
  }

  const ttl = Number(process.env.R2_SIGNED_URL_TTL) || 604800
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl })
  return { key, url, public: false }
}

/** Genera una URL firmada temporal para un objeto ya existente. */
export async function getSignedImageUrl(key: string, ttlSeconds?: number): Promise<string> {
  const client = getClient()
  const ttl = ttlSeconds ?? (Number(process.env.R2_SIGNED_URL_TTL) || 604800)
  return getSignedUrl(client, new GetObjectCommand({ Bucket: getBucket(), Key: key }), { expiresIn: ttl })
}

/** Elimina un objeto del bucket. */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient()
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }))
}

/**
 * Elimina todos los objetos cuyo key empieza por `prefix` (equivalente a borrar
 * una "carpeta" en R2/S3, que no tiene carpetas reales). Devuelve el número de
 * objetos eliminados.
 */
export async function deleteByPrefix(prefix: string): Promise<number> {
  const client = getClient()
  const bucket = getBucket()
  let deleted = 0
  let token: string | undefined

  do {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }))
    const objects = list.Contents ?? []
    for (const obj of objects) {
      if (!obj.Key) continue
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
      deleted++
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (token)

  return deleted
}

/** Construye una key de R2 estable para una foto de operación. */
export function buildOperationKey(trackingCode: string, fileName: string, productCode?: string): string {
  const tc = trackingCode.replace(/[^a-zA-Z0-9._-]/g, '_')
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  return productCode
    ? `operations/${tc}/${productCode.replace(/[^a-zA-Z0-9._-]/g, '_')}/${safeName}`
    : `operations/${tc}/${safeName}`
}
