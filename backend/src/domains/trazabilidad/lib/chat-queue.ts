/**
 * COLA POR CHAT para envíos de WhatsApp.
 *
 * Los envíos a un mismo chat salen uno detrás de otro (cada uno completo:
 * encabezado, álbum, textos), así dos envíos lanzados a la vez no se mezclan
 * en el chat y no se dispara una ráfaga desde el mismo número. Los envíos a
 * chats distintos siguen en paralelo. Si un envío falla, los que esperan
 * detrás continúan.
 */
export interface ChatQueue {
  enqueue<T>(chat: string, run: () => Promise<T>): Promise<T>
  /** Envíos en curso o esperando para un chat (incluye el que se está enviando). */
  length(chat: string): number
}

export function createChatQueue(normalize: (chat: string) => string = (c) => c.trim().toLowerCase()): ChatQueue {
  const queues = new Map<string, { tail: Promise<unknown>; length: number }>()
  const keyOf = (chat: string): string => {
    const raw = (chat || '').trim()
    if (!raw) return '__default__'
    try { return normalize(raw) || raw.toLowerCase() } catch { return raw.toLowerCase() }
  }
  return {
    enqueue<T>(chat: string, run: () => Promise<T>): Promise<T> {
      const key = keyOf(chat)
      const q = queues.get(key) ?? { tail: Promise.resolve(), length: 0 }
      q.length++
      const result = q.tail.catch(() => undefined).then(run)
      q.tail = result.catch(() => undefined).finally(() => {
        q.length--
        if (q.length <= 0 && queues.get(key) === q) queues.delete(key)
      })
      queues.set(key, q)
      return result
    },
    length(chat: string): number {
      return queues.get(keyOf(chat))?.length ?? 0
    },
  }
}
