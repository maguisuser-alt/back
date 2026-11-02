/**
 * Capa de datos — MongoDB Atlas como fuente primaria.
 * `readDatabase()` arma un snapshot en memoria de todas las colecciones y los
 * helpers CRUD persisten directamente en Mongo.
 */
import { nanoid } from 'nanoid'
import {
  getAcademicCoursesCollection,
  getAcademicEventsCollection,
  getAcademicGroupsCollection,
  getAsistenciaAlertasCollection,
  getClassSessionsCollection,
  getCompaniesCollection,
  getFaceVerificationLogsCollection,
  getInstructorAttendancesCollection,
  getJustificacionesCollection,
  getLocationsCollection,
  getStudentAttendancesCollection,
  getSubjectsCollection,
  getUserInvitationsCollection,
  getUsersCollection,
} from './mongodb.js'
import type {
  AcademicCourse,
  AcademicEvent,
  AcademicGroup,
  AsistenciaAlerta,
  ClassSession,
  Company,
  DatabaseSchema,
  FaceVerificationLog,
  InstructorAttendance,
  Justificacion,
  Location,
  StoredWebAuthnCredential,
  StudentAttendance,
  Subject,
  User,
  UserInvitation,
} from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCredentialTransports(value: unknown): StoredWebAuthnCredential['transports'] {
  if (!Array.isArray(value)) return undefined
  const transports = value.filter((item): item is string => typeof item === 'string')
  return transports.length ? transports : undefined
}

export function normalizeUserBiometricProfile(user: User) {
  const biometric = user.biometric
  if (!biometric) return undefined
  return {
    ...biometric,
    credentials: Array.isArray(biometric.credentials)
      ? biometric.credentials.map((credential) => ({
          ...credential,
          publicKey: Array.isArray(credential.publicKey)
            ? credential.publicKey.filter((item): item is number => typeof item === 'number')
            : [],
          transports: normalizeCredentialTransports(credential.transports),
        }))
      : [],
  }
}

// ── readDatabase / writeDatabase ─────────────────────────────────────────────

export async function readDatabase(): Promise<DatabaseSchema> {
  const [
    companies, users, locations, userInvitations,
    subjects, academicCourses, academicGroups, classSessions, studentAttendances,
    instructorAttendances, justificaciones, academicEvents, asistenciaAlertas, faceVerificationLogs,
  ] = await Promise.all([
    getCompaniesCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getUsersCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getLocationsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getUserInvitationsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getSubjectsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getAcademicCoursesCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getAcademicGroupsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getClassSessionsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getStudentAttendancesCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getInstructorAttendancesCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getJustificacionesCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getAcademicEventsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getAsistenciaAlertasCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
    getFaceVerificationLogsCollection().then((c) => c.find().project({ _id: 0 }).toArray()),
  ])

  return {
    companies, users, locations, userInvitations,
    subjects, academicCourses, academicGroups, classSessions, studentAttendances,
    instructorAttendances, justificaciones, academicEvents, asistenciaAlertas, faceVerificationLogs,
  } as DatabaseSchema
}

export async function writeDatabase(_data: DatabaseSchema) {
  // No-op — cada operación guarda directamente en MongoDB
}

// ── Company ──────────────────────────────────────────────────────────────────

export async function createCompany(company: Omit<Company, 'id'>) {
  const col = await getCompaniesCollection()
  const doc: Company = { id: `company-${Date.now()}`, ...company }
  await col.insertOne({ ...doc } as any)
  return doc
}

export async function updateCompany(company: Company) {
  const col = await getCompaniesCollection()
  await col.updateOne({ id: company.id }, { $set: company as any })
  return company
}

export async function deleteCompany(companyId: string) {
  const [companies, users, locations, invitations, subjects, courses, groups, sessions, satt, iatt, just, events, alertas] = await Promise.all([
    getCompaniesCollection(), getUsersCollection(), getLocationsCollection(), getUserInvitationsCollection(),
    getSubjectsCollection(), getAcademicCoursesCollection(), getAcademicGroupsCollection(), getClassSessionsCollection(),
    getStudentAttendancesCollection(), getInstructorAttendancesCollection(), getJustificacionesCollection(),
    getAcademicEventsCollection(), getAsistenciaAlertasCollection(),
  ])
  await Promise.all([
    users.deleteMany({ companyId }), locations.deleteMany({ companyId }), invitations.deleteMany({ companyId }),
    subjects.deleteMany({ companyId }), courses.deleteMany({ companyId }), groups.deleteMany({ companyId }),
    sessions.deleteMany({ companyId }), satt.deleteMany({ companyId }), iatt.deleteMany({ companyId }),
    just.deleteMany({ companyId }), events.deleteMany({ companyId }), alertas.deleteMany({ companyId }),
  ])
  await companies.deleteOne({ id: companyId })
}

// ── User ─────────────────────────────────────────────────────────────────────

export async function createUser(user: Omit<User, 'id'>) {
  const col = await getUsersCollection()
  const doc: User = {
    id: `user-${Date.now()}-${nanoid(4)}`,
    biometric: normalizeUserBiometricProfile(user as User),
    ...user,
  }
  await col.insertOne({ ...doc } as any)
  return doc
}

export async function updateUser(user: User) {
  const normalized: User = { ...user, biometric: normalizeUserBiometricProfile(user) }
  const col = await getUsersCollection()
  await col.updateOne({ id: user.id }, { $set: normalized as any })
  return normalized
}

export async function updateUserLocal(user: User) {
  return updateUser(user)
}

export async function readLocalUser(userId: string): Promise<User | null> {
  const col = await getUsersCollection()
  return (await col.findOne({ id: userId }, { projection: { _id: 0 } })) as User | null
}

export async function deleteUser(userId: string, _companyId: string) {
  const col = await getUsersCollection()
  await col.deleteOne({ id: userId })
}

// ── Location ─────────────────────────────────────────────────────────────────

export async function createLocation(location: Omit<Location, 'id'>) {
  const col = await getLocationsCollection()
  const doc: Location = { id: `location-${Date.now()}`, ...location }
  await col.insertOne({ ...doc } as any)
  return doc
}

export async function updateLocation(location: Location) {
  const col = await getLocationsCollection()
  await col.updateOne({ id: location.id }, { $set: location as any })
  return location
}

export async function deleteLocation(locationId: string, _companyId: string) {
  const col = await getLocationsCollection()
  await col.deleteOne({ id: locationId })
}

// ── UserInvitation ───────────────────────────────────────────────────────────

export async function createUserInvitation(
  invitation: Omit<UserInvitation, 'id' | 'token' | 'status' | 'createdAt' | 'expiresAt'>,
  ttlMs = 60 * 60 * 1000,
) {
  const col = await getUserInvitationsCollection()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  const doc: UserInvitation = {
    id: `invite-${Date.now()}`,
    token: nanoid(24),
    status: 'pendiente',
    expiresAt,
    createdAt: now.toISOString(),
    ...invitation,
  }
  await col.insertOne({ ...doc } as any)
  return doc
}

export async function updateUserInvitation(invitation: UserInvitation) {
  const col = await getUserInvitationsCollection()
  await col.updateOne({ id: invitation.id }, { $set: invitation as any })
  return invitation
}

export async function findUserInvitationByToken(token: string): Promise<UserInvitation | null> {
  const col = await getUserInvitationsCollection()
  return (await col.findOne({ token }, { projection: { _id: 0 } })) as UserInvitation | null
}

// ── Subject ──────────────────────────────────────────────────────────────────

export async function createSubject(subject: Omit<Subject, 'id'>) {
  const col = await getSubjectsCollection()
  const doc: Subject = { id: `subj-${Date.now()}-${nanoid(4)}`, ...subject }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateSubject(subject: Subject) {
  const col = await getSubjectsCollection()
  await col.updateOne({ id: subject.id, companyId: subject.companyId }, { $set: subject as any })
  return subject
}
export async function deleteSubject(id: string, companyId: string) {
  const col = await getSubjectsCollection()
  await col.deleteOne({ id, companyId })
}

// ── AcademicCourse ───────────────────────────────────────────────────────────

export async function createAcademicCourse(course: Omit<AcademicCourse, 'id'>) {
  const col = await getAcademicCoursesCollection()
  const doc: AcademicCourse = { id: `course-${Date.now()}-${nanoid(4)}`, ...course }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateAcademicCourse(course: AcademicCourse) {
  const col = await getAcademicCoursesCollection()
  await col.updateOne({ id: course.id }, { $set: course as any })
  return course
}
export async function deleteAcademicCourse(id: string, companyId: string) {
  const col = await getAcademicCoursesCollection()
  await col.deleteOne({ id, companyId })
}

// ── AcademicGroup ────────────────────────────────────────────────────────────

export async function createAcademicGroup(group: Omit<AcademicGroup, 'id'>) {
  const col = await getAcademicGroupsCollection()
  const doc: AcademicGroup = { id: `grp-${Date.now()}-${nanoid(4)}`, ...group }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateAcademicGroup(group: AcademicGroup) {
  const col = await getAcademicGroupsCollection()
  await col.updateOne({ id: group.id, companyId: group.companyId }, { $set: group as any })
  return group
}
export async function deleteAcademicGroup(id: string, companyId: string) {
  const col = await getAcademicGroupsCollection()
  await col.deleteOne({ id, companyId })
}

// ── ClassSession ─────────────────────────────────────────────────────────────

export async function createClassSession(session: Omit<ClassSession, 'id'>) {
  const col = await getClassSessionsCollection()
  const doc: ClassSession = { id: `sess-${Date.now()}-${nanoid(4)}`, ...session }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateClassSession(session: ClassSession) {
  const col = await getClassSessionsCollection()
  await col.updateOne({ id: session.id, companyId: session.companyId }, { $set: session as any })
  return session
}
export async function deleteClassSession(id: string, companyId: string) {
  const col = await getClassSessionsCollection()
  await col.deleteOne({ id, companyId })
}

// ── StudentAttendance ────────────────────────────────────────────────────────

export async function createStudentAttendance(att: Omit<StudentAttendance, 'id'>) {
  const col = await getStudentAttendancesCollection()
  const doc: StudentAttendance = { id: `sa-${Date.now()}-${nanoid(4)}`, ...att }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateStudentAttendance(att: StudentAttendance) {
  const col = await getStudentAttendancesCollection()
  await col.updateOne({ id: att.id }, { $set: att as any })
  return att
}
export async function upsertStudentAttendance(
  filter: { sessionId: string; estudianteUserId: string },
  data: Partial<StudentAttendance> & Pick<StudentAttendance, 'companyId' | 'academicGroupId' | 'subjectId' | 'fecha' | 'estudianteUserId' | 'estudianteNombre' | 'estado'>,
) {
  const col = await getStudentAttendancesCollection()
  const existing = await col.findOne({ companyId: data.companyId, sessionId: filter.sessionId, estudianteUserId: filter.estudianteUserId })
  if (existing) {
    const merged: StudentAttendance = { ...(existing as any), ...data, updatedAt: new Date().toISOString() }
    await col.updateOne({ id: merged.id }, { $set: merged as any })
    return merged
  }
  return createStudentAttendance(data as any)
}

// ── InstructorAttendance ─────────────────────────────────────────────────────

export async function createInstructorAttendance(att: Omit<InstructorAttendance, 'id'>) {
  const col = await getInstructorAttendancesCollection()
  const doc: InstructorAttendance = { id: `ia-${Date.now()}-${nanoid(4)}`, ...att }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateInstructorAttendance(att: InstructorAttendance) {
  const col = await getInstructorAttendancesCollection()
  await col.updateOne({ id: att.id }, { $set: att as any })
  return att
}
export async function upsertInstructorAttendance(
  filter: { sessionId: string },
  data: Partial<InstructorAttendance> & Pick<InstructorAttendance, 'companyId' | 'academicGroupId' | 'subjectId' | 'fecha' | 'docenteUserId' | 'docenteNombre' | 'estado'>,
) {
  const col = await getInstructorAttendancesCollection()
  const existing = await col.findOne({ companyId: data.companyId, sessionId: filter.sessionId })
  if (existing) {
    const merged: InstructorAttendance = { ...(existing as any), ...data, updatedAt: new Date().toISOString() }
    await col.updateOne({ id: merged.id }, { $set: merged as any })
    return merged
  }
  return createInstructorAttendance(data as any)
}

// ── Justificacion ────────────────────────────────────────────────────────────

export async function createJustificacion(j: Omit<Justificacion, 'id'>) {
  const col = await getJustificacionesCollection()
  const doc: Justificacion = { id: `just-${Date.now()}-${nanoid(4)}`, ...j }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateJustificacion(j: Justificacion) {
  const col = await getJustificacionesCollection()
  await col.updateOne({ id: j.id }, { $set: j as any })
  return j
}

// ── AcademicEvent ────────────────────────────────────────────────────────────

export async function createAcademicEvent(ev: Omit<AcademicEvent, 'id'>) {
  const col = await getAcademicEventsCollection()
  const doc: AcademicEvent = { id: `evt-${Date.now()}-${nanoid(4)}`, ...ev }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateAcademicEvent(ev: AcademicEvent) {
  const col = await getAcademicEventsCollection()
  await col.updateOne({ id: ev.id }, { $set: ev as any })
  return ev
}

// ── AsistenciaAlerta ─────────────────────────────────────────────────────────

export async function createAsistenciaAlerta(alerta: Omit<AsistenciaAlerta, 'id'>) {
  const col = await getAsistenciaAlertasCollection()
  const doc: AsistenciaAlerta = { id: `alt-${Date.now()}-${nanoid(4)}`, ...alerta }
  await col.insertOne({ ...doc } as any)
  return doc
}
export async function updateAsistenciaAlerta(alerta: AsistenciaAlerta) {
  const col = await getAsistenciaAlertasCollection()
  await col.updateOne({ id: alerta.id }, { $set: alerta as any })
  return alerta
}

// ── FaceVerificationLog ──────────────────────────────────────────────────────

export async function createFaceVerificationLog(log: Omit<FaceVerificationLog, 'id'>) {
  const col = await getFaceVerificationLogsCollection()
  const doc: FaceVerificationLog = { id: `fvl-${Date.now()}-${nanoid(4)}`, ...log }
  await col.insertOne({ ...doc } as any)
  return doc
}

// ── Helpers académicos ───────────────────────────────────────────────────────

export function calcularMinutosTardanza(
  horaInicioSesion: string,
  horaIngresoISO: string,
  toleranciaMin = 0,
): number {
  try {
    const [h, m] = horaInicioSesion.split(':').map(Number)
    const inicio = new Date(horaIngresoISO)
    inicio.setHours(h, m, 0, 0)
    const ingreso = new Date(horaIngresoISO)
    const diffMin = Math.round((ingreso.getTime() - inicio.getTime()) / 60000)
    return Math.max(0, diffMin - toleranciaMin)
  } catch {
    return 0
  }
}

export function generarQrTokenSesion(sessionId: string, companyId: string, expiracionMin = 30): { token: string; payload: string; expiracion: string } {
  const expiracion = new Date(Date.now() + expiracionMin * 60_000).toISOString()
  const payload = JSON.stringify({ sessionId, companyId, exp: expiracion, nonce: nanoid(8) })
  const token = Buffer.from(payload).toString('base64url')
  return { token, payload, expiracion }
}

export function validarQrTokenSesion(token: string): { sessionId: string; companyId: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sessionId?: string; companyId?: string; exp?: string }
    if (!decoded.sessionId || !decoded.companyId || !decoded.exp) return null
    if (new Date(decoded.exp) < new Date()) return null
    return { sessionId: decoded.sessionId, companyId: decoded.companyId }
  } catch {
    return null
  }
}
