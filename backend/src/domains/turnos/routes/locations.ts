import { Router } from 'express'
import { createLocation, deleteLocation, readDatabase, updateLocation } from '../lib/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const locationsRouter = Router()

function normalizeGoogleMapsUrl(url: string) {
  const trimmedUrl = url.trim()
  const decodedUrl = decodeURIComponent(trimmedUrl)

  if (/^https?:\/\//i.test(decodedUrl)) {
    return decodedUrl
  }

  return `https://${decodedUrl.replace(/^\/+/, '')}`
}

function extractCoordinatesFromText(rawValue: string) {
  const decodedUrl = decodeURIComponent(rawValue)
  const patterns = [
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  ]

  for (const pattern of patterns) {
    const match = decodedUrl.match(pattern)

    if (match) {
      return {
        latitud: match[1],
        longitud: match[2],
      }
    }
  }

  return null
}

async function extractCoordinatesFromGoogleMapsUrl(url: string) {
  const normalizedUrl = normalizeGoogleMapsUrl(url)
  const directCoordinates = extractCoordinatesFromText(normalizedUrl)

  if (directCoordinates) {
    return directCoordinates
  }

  try {
    const response = await fetch(normalizedUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,application/json',
      },
    })

    const resolvedCoordinates = extractCoordinatesFromText(response.url)
    if (resolvedCoordinates) {
      return resolvedCoordinates
    }

    const body = await response.text()
    return extractCoordinatesFromText(body)
  } catch {
    return null
  }
}

locationsRouter.use(requireAuth)

locationsRouter.get('/', async (request, response) => {
  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  const locations = db.locations.filter(
    (location) => location.companyId === companyId,
  )

  response.json(locations)
})

locationsRouter.post('/', requireRole(['admin']), async (request, response) => {
  const { nombre, direccion, googleMapsUrl, radioTolerancia, descripcion } = request.body ?? {}

  if (!nombre || !googleMapsUrl) {
    response
      .status(400)
      .json({ message: 'El nombre del punto y la URL de Google Maps son requeridos.' })
    return
  }

  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  if (!companyId) {
    response.status(400).json({
      message: 'No fue posible identificar la compania asociada al usuario autenticado.',
    })
    return
  }

  const coordinates = await extractCoordinatesFromGoogleMapsUrl(String(googleMapsUrl))

  if (!coordinates) {
    response.status(400).json({
      message: 'No fue posible obtener latitud y longitud desde la URL de Google Maps.',
    })
    return
  }

  const location = await createLocation({
    companyId,
    nombre: String(nombre),
    direccion: direccion ? String(direccion) : undefined,
    latitud: coordinates.latitud,
    longitud: coordinates.longitud,
    radioTolerancia: radioTolerancia ? String(radioTolerancia) : undefined,
    descripcion: descripcion ? String(descripcion) : undefined,
    createdAt: new Date().toISOString(),
  })

  response.status(201).json(location)
})

locationsRouter.patch('/:id', requireRole(['admin']), async (request, response) => {
  const { id } = request.params
  const { nombre, direccion, googleMapsUrl, radioTolerancia, descripcion } = request.body ?? {}

  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  const existing = db.locations.find(
    (loc) => loc.id === id && loc.companyId === companyId,
  )

  if (!existing) {
    response.status(404).json({ message: 'Ubicacion no encontrada.' })
    return
  }

  // Re-extract coordinates only if a new Google Maps URL is provided
  let latitud = existing.latitud
  let longitud = existing.longitud

  if (googleMapsUrl && googleMapsUrl !== existing.direccion) {
    const coordinates = await extractCoordinatesFromGoogleMapsUrl(String(googleMapsUrl))
    if (coordinates) {
      latitud = coordinates.latitud
      longitud = coordinates.longitud
    }
  }

  const updated = await updateLocation({
    ...existing,
    nombre: nombre ? String(nombre) : existing.nombre,
    direccion: direccion !== undefined ? String(direccion) : existing.direccion,
    latitud,
    longitud,
    radioTolerancia: radioTolerancia !== undefined ? String(radioTolerancia) : existing.radioTolerancia,
    descripcion: descripcion !== undefined ? String(descripcion) : existing.descripcion,
  })

  response.json(updated)
})

locationsRouter.delete('/:id', requireRole(['admin']), async (request, response) => {
  const id = String(request.params.id)

  const db = await readDatabase()
  const companyId =
    request.authUser!.companyId ||
    db.users.find((user) => user.id === request.authUser!.userId)?.companyId ||
    ''

  const existing = db.locations.find(
    (loc) => loc.id === id && loc.companyId === companyId,
  )

  if (!existing) {
    response.status(404).json({ message: 'Ubicacion no encontrada.' })
    return
  }

  // Prevent deletion if location is used by active turns
  const hasTurns = db.turns.some(
    (turn) => turn.locationId === id && turn.estado !== 'finalizado',
  )

  if (hasTurns) {
    response.status(409).json({
      message: 'No se puede eliminar una ubicacion con turnos activos. Finaliza o reasigna los turnos primero.',
    })
    return
  }

  await deleteLocation(id, companyId)
  response.status(204).send()
})
