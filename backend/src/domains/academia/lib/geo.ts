/**
 * Utilidades de geolocalización y fechas.
 */

/** Fecha "hoy" (YYYY-MM-DD) en la zona horaria indicada (default America/Bogota). */
export function todayInTimezone(timezone = 'America/Bogota'): string {
  try {
    // en-CA produce formato YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

/** Distancia en metros entre dos coordenadas (haversine). */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadius = 6371000
  const dLat = degreesToRadians(lat2 - lat1)
  const dLon = degreesToRadians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Convierte un valor (string|number) a coordenada numérica o null. */
export function parseCoord(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export type DistanceCheck = {
  distanceMeters: number
  allowedRadiusMeters: number
  withinRange: boolean
}

/**
 * Valida que (lat,lon) esté dentro del radio de una sede con lat/lng/radioTolerancia (strings).
 * Devuelve null si la sede no tiene coordenadas (no se puede validar).
 */
export function checkWithinLocation(
  location: { latitud?: string; longitud?: string; radioTolerancia?: string },
  lat: number,
  lon: number,
): DistanceCheck | null {
  const slat = parseCoord(location.latitud)
  const slon = parseCoord(location.longitud)
  if (slat === null || slon === null) return null
  const allowed = Number(location.radioTolerancia ?? 100)
  const radius = Number.isFinite(allowed) ? allowed : 100
  const dist = distanceMeters(slat, slon, lat, lon)
  return {
    distanceMeters: Math.round(dist),
    allowedRadiusMeters: radius,
    withinRange: dist <= radius,
  }
}
