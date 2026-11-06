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

/** Desfase (ms) de la zona horaria respecto a UTC en el instante dado. */
function tzOffsetMs(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return asUtc - Math.floor(at.getTime() / 1000) * 1000
  } catch {
    return -5 * 3_600_000 // fallback America/Bogota
  }
}

/** Milisegundos UTC de una fecha (YYYY-MM-DD) y hora (HH:mm) locales en la zona dada. */
export function zonedTimeToMs(fecha: string, hora: string, timezone = 'America/Bogota'): number {
  const [y, mo, d] = fecha.split('-').map(Number)
  const [h, mi] = hora.split(':').map(Number)
  const guess = Date.UTC(y, (mo ?? 1) - 1, d, h, mi ?? 0)
  const first = guess - tzOffsetMs(timezone, new Date(guess))
  // Segunda pasada por si el desfase cambia entre ambos instantes (DST)
  return guess - tzOffsetMs(timezone, new Date(first))
}

/** Hora local (0-23.99) en la zona dada para un instante. */
export function localHourOf(ms: number, timezone = 'America/Bogota'): number {
  const local = new Date(ms + tzOffsetMs(timezone, new Date(ms)))
  return local.getUTCHours() + local.getUTCMinutes() / 60
}

/** Horas trabajadas dentro de la franja nocturna [startHour, endHour) (cruza medianoche). */
export function nightHoursBetween(startMs: number, endMs: number, timezone: string, nightStart = 19, nightEnd = 6): number {
  if (!(endMs > startMs)) return 0
  let minutes = 0
  for (let t = startMs; t < endMs; t += 60_000) {
    const h = localHourOf(t, timezone)
    if (h >= nightStart || h < nightEnd) minutes++
  }
  return Math.round((minutes / 60) * 100) / 100
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
