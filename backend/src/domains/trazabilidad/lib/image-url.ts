/**
 * Utilidades puras de URLs de imagen para el envío por WhatsApp.
 *
 * Se separan de whatsapp-web.ts (que importa Baileys) para poder probarlas de
 * forma ligera y reutilizarlas sin arrastrar dependencias pesadas.
 */

/**
 * Normaliza una URL de imagen a una forma DIRECTAMENTE descargable.
 *
 * Convierte enlaces de Google Drive (que devuelven HTML, no bytes de imagen) a
 * su forma de descarga directa. Es la causa típica de "algunas fotos no se
 * envían": Baileys recibe HTML en vez de una imagen y falla. Las URLs de R2,
 * GitHub u otras CDNs se devuelven sin cambios.
 */
export function toDirectImageUrl(url: string): string {
  if (!url) return url
  // https://drive.google.com/file/d/<ID>/view...
  const m1 = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (m1?.[1]) return `https://drive.google.com/uc?export=download&id=${m1[1]}`
  // ...?id=<ID> ó &id=<ID> en dominios de Google
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (m2?.[1] && /drive\.google\.com|googleusercontent/.test(url)) {
    return `https://drive.google.com/uc?export=download&id=${m2[1]}`
  }
  return url
}

/** True si la URL es apta para enviar (http(s) y no un marcador pendiente). */
export function isSendableUrl(url: string | undefined | null): boolean {
  return Boolean(url && url !== 'pending-verification' && /^https?:\/\//.test(url))
}
