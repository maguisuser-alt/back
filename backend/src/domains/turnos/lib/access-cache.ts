/**
 * Caché corta del estado de acceso (empresa activa / usuario activo).
 *
 * `requireAuth` la consulta en cada request para bloquear al instante a un
 * usuario o empresa desactivados aunque su token siga vigente. Para no hacer
 * dos consultas a Mongo por request se guarda unos segundos, y se INVALIDA en
 * cuanto el root o un admin cambia algo (así el cambio aplica en la siguiente
 * petición, no tras el vencimiento de la caché).
 */
import { getCompaniesCollection, getUsersCollection } from './mongodb.js'

const TTL_MS = 10_000

const companyCache = new Map<string, { activa: boolean; at: number }>()
const userCache = new Map<string, { activa: boolean; companyId: string; at: number }>()

/** false solo si la empresa existe y está marcada como inactiva. */
export async function isCompanyActive(companyId: string): Promise<boolean> {
  const hit = companyCache.get(companyId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.activa
  const company = (await (await getCompaniesCollection()).findOne(
    { id: companyId } as never,
    { projection: { _id: 0, activa: 1 } },
  )) as { activa?: boolean } | null
  const activa = company?.activa !== false
  companyCache.set(companyId, { activa, at: Date.now() })
  return activa
}

/**
 * false si el usuario no existe, fue desactivado o ya no pertenece a la
 * empresa del token. `activa` ausente (usuarios antiguos) cuenta como activo.
 */
export async function isUserActive(userId: string, companyId: string): Promise<boolean> {
  const hit = userCache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.activa && hit.companyId === companyId
  const user = (await (await getUsersCollection()).findOne(
    { id: userId } as never,
    { projection: { _id: 0, activa: 1, companyId: 1 } },
  )) as { activa?: boolean; companyId?: string } | null
  const activa = Boolean(user) && user!.activa !== false
  userCache.set(userId, { activa, companyId: user?.companyId ?? '', at: Date.now() })
  return activa && user?.companyId === companyId
}

/** Llamar tras cambiar empresa/usuario: el siguiente request lee el valor real. */
export function invalidateAccess(opts: { companyId?: string; userId?: string }): void {
  if (opts.companyId) companyCache.delete(opts.companyId)
  if (opts.userId) userCache.delete(opts.userId)
}
