/**
 * Permuta de turnos entre trabajadores.
 *
 * Flujo:
 *  1. POST   /swaps               → A propone cambiar su turno por el de B.
 *  2. PATCH  /swaps/:id/respond   → B acepta o rechaza.
 *  3. PATCH  /swaps/:id/approve   → supervisor/admin aprueba o rechaza.
 *     Al aprobar se intercambian las asignaciones de ambos turnos.
 *  *  PATCH  /swaps/:id/cancel    → quien propone cancela mientras siga abierta.
 *
 * Solo disponible si la empresa activó `settings.permitirPermutaTurnos`.
 */
import { Router } from 'express'
import { nanoid } from 'nanoid'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { todayInTimezone, zonedTimeToMs } from '../lib/geo.js'
import { getCompaniesCollection, getDb, getTurnsCollection, getUsersCollection } from '../lib/mongodb.js'
import type { Company, Turn, TurnSwap, User } from '../types.js'

export const swapsRouter = Router()
swapsRouter.use(requireAuth)

const SWAPS_COLLECTION = 'turnSwaps'
const ACTIVE_TURN_STATES = ['pendiente', 'asignado', 'confirmado']
const OPEN_SWAP_STATES = ['pendiente_companero', 'pendiente_aprobacion']

const swapsCol = async () => (await getDb()).collection<TurnSwap>(SWAPS_COLLECTION)

async function loadCompany(companyId: string): Promise<Company | null> {
  return (await (await getCompaniesCollection()).findOne({ id: companyId } as any, { projection: { _id: 0 } })) as Company | null
}

/** Un turno se puede permutar si aún no empezó (sin entrada) y su estado sigue activo. */
function isSwappable(turn: Turn, timezone: string): string | null {
  if (!ACTIVE_TURN_STATES.includes(turn.estado)) return `El turno del ${turn.fecha} está en estado "${turn.estado}" y no se puede permutar.`
  if (turn.attendance?.checkIn) return `El turno del ${turn.fecha} ya tiene entrada marcada.`
  if (zonedTimeToMs(turn.fecha, turn.hora, timezone) <= Date.now()) return `El turno del ${turn.fecha} ya comenzó o pasó.`
  return null
}

/** true si el usuario tiene otro turno activo ese día distinto a los excluidos. */
async function hasConflict(userId: string, fecha: string, excludeIds: string[]): Promise<boolean> {
  const turns = await getTurnsCollection()
  const found = await turns.findOne({
    assignedToUserId: userId,
    fecha,
    estado: { $in: ACTIVE_TURN_STATES },
    id: { $nin: excludeIds },
  } as any)
  return Boolean(found)
}

/** GET /swaps/config — indica si la empresa tiene activada la permuta (lo puede leer cualquier rol). */
swapsRouter.get('/config', async (request, response) => {
  const company = await loadCompany(request.authUser!.companyId)
  response.json({ enabled: Boolean(company?.settings?.permitirPermutaTurnos) })
})

/** GET /swaps/candidates — turnos futuros de compañeros con los que se puede permutar. */
swapsRouter.get('/candidates', async (request, response) => {
  const { companyId, userId } = request.authUser!
  const company = await loadCompany(companyId)
  if (!company?.settings?.permitirPermutaTurnos) { response.json([]); return }
  const timezone = company.settings.timezone || 'America/Bogota'
  const turns = await getTurnsCollection()
  const rows = (await turns
    .find({
      companyId,
      estado: { $in: ACTIVE_TURN_STATES },
      assignedToUserId: { $exists: true, $nin: ['', userId] },
      'attendance.checkIn': null,
      fecha: { $gte: todayInTimezone(timezone) },
    } as any)
    .project({ _id: 0, id: 1, fecha: 1, hora: 1, horaFin: 1, locationNombre: 1, assignedToUserId: 1, assignedToUserName: 1, estado: 1 })
    .sort({ fecha: 1, hora: 1 })
    .limit(100)
    .toArray()) as unknown as Turn[]
  response.json(rows.filter((t) => !isSwappable(t, timezone)))
})

/** GET /swaps — supervisores/admin ven todas; el resto, solo las suyas. */
swapsRouter.get('/', async (request, response) => {
  const { companyId, userId, role } = request.authUser!
  const isManager = role === 'admin' || role === 'supervisor'
  const filter: Record<string, unknown> = { companyId }
  if (!isManager) filter.$or = [{ requesterUserId: userId }, { targetUserId: userId }]
  const rows = await (await swapsCol()).find(filter as any).project({ _id: 0 }).sort({ createdAt: -1 }).limit(200).toArray()
  response.json(rows)
})

/** POST /swaps — { turnId, targetTurnId, motivo? } */
swapsRouter.post('/', async (request, response) => {
  const { companyId, userId } = request.authUser!
  const { turnId, targetTurnId, motivo } = (request.body ?? {}) as { turnId?: string; targetTurnId?: string; motivo?: string }
  if (!turnId || !targetTurnId || turnId === targetTurnId) {
    response.status(400).json({ message: 'Indica tu turno y el turno del compañero con el que quieres cambiar.' })
    return
  }

  const company = await loadCompany(companyId)
  if (!company?.settings?.permitirPermutaTurnos) {
    response.status(403).json({ message: 'La permuta de turnos no está habilitada para tu empresa.' })
    return
  }
  const timezone = company.settings.timezone || 'America/Bogota'

  const turns = await getTurnsCollection()
  const [mine, theirs] = await Promise.all([
    turns.findOne({ id: turnId, companyId } as any, { projection: { _id: 0 } }) as Promise<Turn | null>,
    turns.findOne({ id: targetTurnId, companyId } as any, { projection: { _id: 0 } }) as Promise<Turn | null>,
  ])
  if (!mine || !theirs) { response.status(404).json({ message: 'Alguno de los turnos no existe.' }); return }
  if (mine.assignedToUserId !== userId) { response.status(403).json({ message: 'Solo puedes ofrecer turnos asignados a ti.' }); return }
  if (!theirs.assignedToUserId || theirs.assignedToUserId === userId) {
    response.status(400).json({ message: 'El turno elegido debe pertenecer a otro compañero.' })
    return
  }

  const problem = isSwappable(mine, timezone) ?? isSwappable(theirs, timezone)
  if (problem) { response.status(409).json({ message: problem }); return }

  // Ninguno puede quedar con dos turnos el mismo día tras el intercambio
  const pair = [mine.id, theirs.id]
  if (await hasConflict(userId, theirs.fecha, pair)) {
    response.status(409).json({ message: `Ya tienes otro turno el ${theirs.fecha}.` }); return
  }
  if (await hasConflict(theirs.assignedToUserId, mine.fecha, pair)) {
    response.status(409).json({ message: `${theirs.assignedToUserName ?? 'Tu compañero'} ya tiene otro turno el ${mine.fecha}.` }); return
  }

  // Evita propuestas duplicadas sobre los mismos turnos
  const col = await swapsCol()
  const dup = await col.findOne({ companyId, estado: { $in: OPEN_SWAP_STATES }, $or: [{ turnId: { $in: pair } }, { targetTurnId: { $in: pair } }] } as any)
  if (dup) { response.status(409).json({ message: 'Ya existe una permuta abierta que involucra alguno de esos turnos.' }); return }

  const requester = (await (await getUsersCollection()).findOne({ id: userId } as any, { projection: { _id: 0, nombreCompleto: 1 } })) as User | null
  const now = new Date().toISOString()
  const swap: TurnSwap = {
    id: `swap-${Date.now()}-${nanoid(4)}`,
    companyId,
    turnId: mine.id,
    requesterUserId: userId,
    requesterUserName: requester?.nombreCompleto ?? mine.assignedToUserName ?? '',
    targetTurnId: theirs.id,
    targetUserId: theirs.assignedToUserId,
    targetUserName: theirs.assignedToUserName ?? '',
    motivo: typeof motivo === 'string' && motivo.trim() ? motivo.trim().slice(0, 300) : undefined,
    estado: 'pendiente_companero',
    createdAt: now,
    updatedAt: now,
  }
  await col.insertOne({ ...swap } as any)
  response.status(201).json(swap)
})

/** PATCH /swaps/:id/respond — { accept: boolean } — solo el compañero destinatario. */
swapsRouter.patch('/:id/respond', async (request, response) => {
  const { companyId, userId } = request.authUser!
  const { accept } = (request.body ?? {}) as { accept?: boolean }
  const col = await swapsCol()
  const swap = (await col.findOne({ id: request.params.id, companyId } as any, { projection: { _id: 0 } })) as TurnSwap | null
  if (!swap) { response.status(404).json({ message: 'Permuta no encontrada.' }); return }
  if (swap.targetUserId !== userId) { response.status(403).json({ message: 'Solo el compañero invitado puede responder.' }); return }
  if (swap.estado !== 'pendiente_companero') { response.status(409).json({ message: 'La permuta ya no espera tu respuesta.' }); return }

  const now = new Date().toISOString()
  const next = accept ? 'pendiente_aprobacion' : 'rechazada'
  await col.updateOne({ id: swap.id } as any, { $set: { estado: next, respondedAt: now, updatedAt: now } } as any)
  response.json({ ...swap, estado: next, respondedAt: now, updatedAt: now })
})

/** PATCH /swaps/:id/approve — { approve: boolean, rejectionReason? } — admin/supervisor. */
swapsRouter.patch('/:id/approve', requireRole(['admin', 'supervisor']), async (request, response) => {
  const { companyId, userId } = request.authUser!
  const { approve, rejectionReason } = (request.body ?? {}) as { approve?: boolean; rejectionReason?: string }
  const col = await swapsCol()
  const swap = (await col.findOne({ id: request.params.id, companyId } as any, { projection: { _id: 0 } })) as TurnSwap | null
  if (!swap) { response.status(404).json({ message: 'Permuta no encontrada.' }); return }
  if (swap.estado !== 'pendiente_aprobacion') { response.status(409).json({ message: 'La permuta no está pendiente de aprobación.' }); return }

  const users = await getUsersCollection()
  const approver = (await users.findOne({ id: userId } as any, { projection: { _id: 0, nombreCompleto: 1 } })) as User | null
  const now = new Date().toISOString()
  const resolution = { resolvedByUserId: userId, resolvedByUserName: approver?.nombreCompleto, resolvedAt: now, updatedAt: now }

  if (!approve) {
    const reason = typeof rejectionReason === 'string' ? rejectionReason.trim().slice(0, 300) : undefined
    await col.updateOne({ id: swap.id } as any, { $set: { estado: 'rechazada', rejectionReason: reason, ...resolution } } as any)
    response.json({ ...swap, estado: 'rechazada', rejectionReason: reason, ...resolution })
    return
  }

  // Revalida todo: entre la propuesta y la aprobación pudo cambiar algo
  const company = await loadCompany(companyId)
  const timezone = company?.settings?.timezone || 'America/Bogota'
  const turns = await getTurnsCollection()
  const [mine, theirs] = await Promise.all([
    turns.findOne({ id: swap.turnId, companyId } as any, { projection: { _id: 0 } }) as Promise<Turn | null>,
    turns.findOne({ id: swap.targetTurnId, companyId } as any, { projection: { _id: 0 } }) as Promise<Turn | null>,
  ])
  const stale = !mine || !theirs
    || mine.assignedToUserId !== swap.requesterUserId || theirs.assignedToUserId !== swap.targetUserId
  const problem = stale ? 'Los turnos cambiaron desde que se propuso la permuta.' : (isSwappable(mine!, timezone) ?? isSwappable(theirs!, timezone))
  if (problem || !mine || !theirs) {
    await col.updateOne({ id: swap.id } as any, { $set: { estado: 'cancelada', rejectionReason: problem, ...resolution } } as any)
    response.status(409).json({ message: `${problem ?? 'Turnos no disponibles.'} La permuta se canceló.` })
    return
  }
  const pair = [mine.id, theirs.id]
  if (await hasConflict(swap.requesterUserId, theirs.fecha, pair) || await hasConflict(swap.targetUserId, mine.fecha, pair)) {
    await col.updateOne({ id: swap.id } as any, { $set: { estado: 'cancelada', rejectionReason: 'Conflicto de horario', ...resolution } } as any)
    response.status(409).json({ message: 'Alguno de los trabajadores ya tiene otro turno ese día. La permuta se canceló.' })
    return
  }

  // Intercambia asignaciones; reinicia el recordatorio para que avise al nuevo dueño
  const swapOwner = (t: Turn, userIdNew: string, nameNew: string) => turns.updateOne(
    { id: t.id } as any,
    { $set: { assignedToUserId: userIdNew, assignedToUserName: nameNew, estado: 'asignado', updatedAt: now }, $unset: { reminderSentAt: '' } } as any,
  )
  await Promise.all([
    swapOwner(mine, swap.targetUserId, swap.targetUserName),
    swapOwner(theirs, swap.requesterUserId, swap.requesterUserName),
  ])
  await col.updateOne({ id: swap.id } as any, { $set: { estado: 'aprobada', ...resolution } } as any)
  response.json({ ...swap, estado: 'aprobada', ...resolution })
})

/** PATCH /swaps/:id/cancel — quien propone, mientras siga abierta. */
swapsRouter.patch('/:id/cancel', async (request, response) => {
  const { companyId, userId } = request.authUser!
  const col = await swapsCol()
  const swap = (await col.findOne({ id: request.params.id, companyId } as any, { projection: { _id: 0 } })) as TurnSwap | null
  if (!swap) { response.status(404).json({ message: 'Permuta no encontrada.' }); return }
  if (swap.requesterUserId !== userId) { response.status(403).json({ message: 'Solo quien propuso la permuta puede cancelarla.' }); return }
  if (!OPEN_SWAP_STATES.includes(swap.estado)) { response.status(409).json({ message: 'La permuta ya está cerrada.' }); return }
  const now = new Date().toISOString()
  await col.updateOne({ id: swap.id } as any, { $set: { estado: 'cancelada', updatedAt: now } } as any)
  response.json({ ...swap, estado: 'cancelada', updatedAt: now })
})
