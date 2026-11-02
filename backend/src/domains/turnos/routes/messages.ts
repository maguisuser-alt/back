import { type Response, Router } from 'express'
import { requireAuth } from '../middleware/auth.js'

export const messagesRouter = Router()

function normalizePhone(phone: unknown) {
  return String(phone ?? '').replace(/\D/g, '')
}

function resolveText(text: unknown) {
  return String(text ?? '').trim()
}

function buildWhatsAppUrl(phone: string, text: string) {
  const query = text ? `?text=${encodeURIComponent(text)}` : ''
  return `https://wa.me/${phone}${query}`
}

function handleWhatsAppLink(
  phoneInput: unknown,
  textInput: unknown,
  response: Response,
) {
  const phone = normalizePhone(phoneInput)
  const text = resolveText(textInput)

  if (!phone) {
    response.status(400).json({ message: 'El numero de telefono es obligatorio.' })
    return
  }

  if (phone.length < 8 || phone.length > 15) {
    response.status(400).json({
      message: 'El numero de telefono debe estar en formato internacional sin espacios.',
    })
    return
  }

  response.json({
    provider: 'whatsapp',
    mode: 'chat_link',
    phone,
    text,
    whatsappUrl: buildWhatsAppUrl(phone, text),
    note: 'wa.me no envia mensajes desde el backend; devuelve un enlace para abrir el chat con el texto precargado.',
  })
}

messagesRouter.use(requireAuth)

messagesRouter.get('/whatsapp-link', (request, response) => {
  handleWhatsAppLink(request.query.phone, request.query.text, response)
})

messagesRouter.post('/whatsapp-link', (request, response) => {
  const { phone, text } = request.body ?? {}
  handleWhatsAppLink(phone, text, response)
})
