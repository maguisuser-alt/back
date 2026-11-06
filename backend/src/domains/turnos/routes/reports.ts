/**
 * Reportes y KPIs de turnos (solo admin y supervisor).
 *
 *  GET /reports/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Se calcula en el servidor sobre una ventana de fechas acotada (máx. 92 días)
 * para no cargar toda la base ni saturar el plan gratis.
 *
 * NOTA sobre puntualidad: en los marcajes por PIN/mark, `attendance.checkIn.markedAt`
 * guarda la hora PROGRAMADA del turno, no la real. La hora real de llegada está en
 * `locationCheck.verifiedAt`; los turnos sin ese dato no entran al cálculo.
 */
import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { todayInTimezone, zonedTimeToMs } from '../lib/geo.js'
import { getCompaniesCollection, getHorasTurnoCollection, getTurnsCollection } from '../lib/mongodb.js'
import type { Company, HorasTurnoRecord, Turn } from '../types.js'

export const reportsRouter = Router()
reportsRouter.use(requireAuth, requireRole(['admin', 'supervisor']))

const MAX_RANGE_DAYS = 92
const TOLERANCE_MIN = 5 // minutos de gracia para considerar puntual
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const round2 = (n: number) => Math.round(n * 100) / 100

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)
}

reportsRouter.get('/kpis', async (request, response) => {
  const { companyId } = request.authUser!
  const company = (await (await getCompaniesCollection()).findOne({ id: companyId } as any, { projection: { _id: 0, settings: 1 } })) as Company | null
  const timezone = company?.settings?.timezone || 'America/Bogota'

  // Rango: por defecto los últimos 30 días
  const today = todayInTimezone(timezone)
  let { from, to } = request.query as { from?: string; to?: string }
  to = to && DATE_RE.test(to) ? to : today
  from = from && DATE_RE.test(from) ? from : addDays(to, -29)
  if (from > to) { response.status(400).json({ message: 'La fecha inicial no puede ser posterior a la final.' }); return }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    response.status(400).json({ message: `El rango máximo es de ${MAX_RANGE_DAYS} días.` }); return
  }

  const [turns, horas] = await Promise.all([
    (await getTurnsCollection())
      .find({ companyId, fecha: { $gte: from, $lte: to } } as any)
      .project({
        _id: 0, id: 1, fecha: 1, hora: 1, estado: 1, locationId: 1, locationNombre: 1,
        assignedToUserId: 1, assignedToUserName: 1,
        'attendance.checkIn.locationCheck.verifiedAt': 1, 'attendance.checkIn.locationCheck.withinRange': 1,
        'attendance.checkIn.method': 1, 'attendance.checkOut.markedAt': 1,
      })
      .toArray() as unknown as Promise<Turn[]>,
    (await getHorasTurnoCollection())
      .find({ companyId, fecha: { $gte: from, $lte: to } } as any)
      .project({ _id: 0 })
      .toArray() as unknown as Promise<HorasTurnoRecord[]>,
  ])

  // ── Turnos ──
  const porEstado: Record<string, number> = {}
  let conEntrada = 0
  let puntuales = 0
  let tardes = 0
  let sinMedicion = 0
  let fueraDeRango = 0
  let sinSalida = 0
  const tardanzaPorUsuario = new Map<string, { nombre: string; tardes: number; total: number }>()

  for (const t of turns) {
    porEstado[t.estado] = (porEstado[t.estado] ?? 0) + 1
    const checkIn = t.attendance?.checkIn
    if (!checkIn) continue
    conEntrada++
    if (checkIn.locationCheck?.withinRange === false) fueraDeRango++
    if (!t.attendance?.checkOut && (t.estado === 'en_proceso' || t.estado === 'confirmado') && t.fecha < today) sinSalida++

    // Puntualidad con la hora REAL de llegada; los marcajes automáticos no cuentan
    const real = checkIn.method === 'auto' ? undefined : checkIn.locationCheck?.verifiedAt
    if (!real || !t.hora) { sinMedicion++; continue }
    const programada = zonedTimeToMs(t.fecha, t.hora, timezone)
    const retrasoMin = (Date.parse(real) - programada) / 60_000
    if (Number.isNaN(retrasoMin)) { sinMedicion++; continue }
    const esTarde = retrasoMin > TOLERANCE_MIN
    if (esTarde) tardes++; else puntuales++

    const uid = t.assignedToUserId ?? ''
    if (uid) {
      const acc = tardanzaPorUsuario.get(uid) ?? { nombre: t.assignedToUserName ?? uid, tardes: 0, total: 0 }
      acc.total++
      if (esTarde) acc.tardes++
      tardanzaPorUsuario.set(uid, acc)
    }
  }

  const medidos = puntuales + tardes
  const rechazados = porEstado['rechazado'] ?? 0
  const totalTurnos = turns.length

  // ── Horas ──
  const porCargo = new Map<string, { horas: number; extra: number; nocturnas: number; valor: number }>()
  const porUbicacion = new Map<string, { horas: number; turnos: number }>()
  const porDia = new Map<string, number>()
  let totalHoras = 0, totalExtra = 0, totalNocturnas = 0, totalDominicales = 0, totalFestivas = 0, totalValor = 0

  for (const r of horas) {
    const h = r.horasTrabajadas ?? 0
    totalHoras += h
    totalExtra += r.horasExtra ?? 0
    totalNocturnas += r.horasNocturnas ?? 0
    totalDominicales += r.horasDominicales ?? 0
    totalFestivas += r.horasFestivas ?? 0
    totalValor += r.subtotal ?? 0

    const cargo = r.cargo || 'Sin cargo'
    const c = porCargo.get(cargo) ?? { horas: 0, extra: 0, nocturnas: 0, valor: 0 }
    c.horas += h; c.extra += r.horasExtra ?? 0; c.nocturnas += r.horasNocturnas ?? 0; c.valor += r.subtotal ?? 0
    porCargo.set(cargo, c)

    const ubi = r.nombreUbicacion || 'Sin ubicación'
    const u = porUbicacion.get(ubi) ?? { horas: 0, turnos: 0 }
    u.horas += h; u.turnos++
    porUbicacion.set(ubi, u)

    porDia.set(r.fecha, (porDia.get(r.fecha) ?? 0) + h)
  }

  // Serie diaria completa (incluye días sin horas para que la gráfica no tenga huecos)
  const serie: Array<{ fecha: string; horas: number }> = []
  for (let d = from; d <= to; d = addDays(d, 1)) serie.push({ fecha: d, horas: round2(porDia.get(d) ?? 0) })

  response.json({
    rango: { from, to, timezone, toleranciaMin: TOLERANCE_MIN },
    turnos: {
      total: totalTurnos,
      porEstado,
      conEntrada,
      rechazados,
      tasaRechazo: totalTurnos ? round2((rechazados / totalTurnos) * 100) : 0,
      fueraDeRango,
      sinSalida,
    },
    puntualidad: {
      medidos, puntuales, tardes, sinMedicion,
      porcentaje: medidos ? round2((puntuales / medidos) * 100) : null,
    },
    horas: {
      total: round2(totalHoras),
      extra: round2(totalExtra),
      nocturnas: round2(totalNocturnas),
      dominicales: round2(totalDominicales),
      festivas: round2(totalFestivas),
      valor: round2(totalValor),
      registros: horas.length,
    },
    porCargo: [...porCargo.entries()]
      .map(([cargo, v]) => ({ cargo, horas: round2(v.horas), extra: round2(v.extra), nocturnas: round2(v.nocturnas), valor: round2(v.valor) }))
      .sort((a, b) => b.horas - a.horas),
    porUbicacion: [...porUbicacion.entries()]
      .map(([ubicacion, v]) => ({ ubicacion, horas: round2(v.horas), turnos: v.turnos }))
      .sort((a, b) => b.horas - a.horas),
    topTardanzas: [...tardanzaPorUsuario.entries()]
      .map(([userId, v]) => ({ userId, nombre: v.nombre, tardes: v.tardes, total: v.total }))
      .filter((x) => x.tardes > 0)
      .sort((a, b) => b.tardes - a.tardes)
      .slice(0, 5),
    serieDiaria: serie,
  })
})
