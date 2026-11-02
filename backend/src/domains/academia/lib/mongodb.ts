/**
 * Acceso a MongoDB del dominio ACADEMIA.
 *
 * La conexión ya NO se gestiona aquí: se delega en la capa ÚNICA
 * (`core/mongo.ts`), que expone el handle `academia` (base `ommex_academia`)
 * sobre el MISMO pool de conexiones que turnos y trazabilidad.
 *
 * Se conservan los mismos exports que el módulo original para no tocar las
 * rutas ni la lógica. Los nombres de base y de colección NO cambian.
 */
import type { Collection, Db } from 'mongodb'
import { getDb as coreDb } from '../../../core/mongo.js'
import type {
  AcademicCourse,
  AcademicEvent,
  AcademicGroup,
  AsistenciaAlerta,
  ClassSession,
  Company,
  FaceVerificationLog,
  InstructorAttendance,
  Justificacion,
  Location,
  StudentAttendance,
  Subject,
  User,
  UserInvitation,
} from '../types.js'

const DOMAIN = 'academia' as const

async function createIndexes(database: Db) {
  try {
    // Migración: elimina índices únicos GLOBALES antiguos de users que impedían
    // tener la misma persona en instituciones distintas (ahora son por companyId).
    for (const stale of ['numeroDocumento_1', 'correo_1']) {
      try { await database.collection('users').dropIndex(stale) } catch { /* no existía */ }
    }

    await database.collection('companies').createIndex({ nit: 1 }, { unique: true, sparse: true })
    // externalId (companyId del producto de turnos) debe ser único: una institución por compañía externa.
    await database.collection('companies').createIndex({ externalId: 1 }, { unique: true, sparse: true })
    await database.collection('users').createIndex({ companyId: 1 })
    // Documento/correo únicos POR institución (no globales), para aislar entre compañías.
    await database.collection('users').createIndex({ companyId: 1, numeroDocumento: 1 }, { unique: true, sparse: true })
    await database.collection('users').createIndex({ companyId: 1, correo: 1 }, { sparse: true })
    await database.collection('locations').createIndex({ companyId: 1 })
    await database.collection('userInvitations').createIndex({ token: 1 }, { unique: true })
    await database.collection('subjects').createIndex({ companyId: 1 })
    await database.collection('subjects').createIndex({ companyId: 1, codigo: 1 }, { unique: true, sparse: true })
    await database.collection('academicCourses').createIndex({ companyId: 1 })
    await database.collection('academicCourses').createIndex({ companyId: 1, codigo: 1 }, { unique: true, sparse: true })
    await database.collection('academicGroups').createIndex({ companyId: 1 })
    await database.collection('academicGroups').createIndex({ companyId: 1, subjectId: 1 })
    await database.collection('academicGroups').createIndex({ companyId: 1, docenteUserId: 1 })
    await database.collection('classSessions').createIndex({ companyId: 1, fecha: 1 })
    await database.collection('classSessions').createIndex({ companyId: 1, academicGroupId: 1, fecha: 1 })
    await database.collection('classSessions').createIndex({ qrToken: 1 }, { sparse: true })
    await database.collection('studentAttendances').createIndex({ companyId: 1, fecha: 1 })
    await database.collection('studentAttendances').createIndex({ companyId: 1, sessionId: 1 })
    await database.collection('studentAttendances').createIndex({ companyId: 1, estudianteUserId: 1, fecha: 1 })
    await database.collection('studentAttendances').createIndex({ companyId: 1, sessionId: 1, estudianteUserId: 1 }, { unique: true, sparse: true })
    await database.collection('instructorAttendances').createIndex({ companyId: 1, fecha: 1 })
    await database.collection('instructorAttendances').createIndex({ companyId: 1, docenteUserId: 1, fecha: 1 })
    await database.collection('instructorAttendances').createIndex({ companyId: 1, sessionId: 1 }, { unique: true, sparse: true })
    await database.collection('justificaciones').createIndex({ companyId: 1, createdAt: -1 })
    await database.collection('justificaciones').createIndex({ companyId: 1, solicitanteUserId: 1 })
    await database.collection('academicEvents').createIndex({ companyId: 1, fecha: 1 })
    await database.collection('asistenciaAlertas').createIndex({ companyId: 1, createdAt: -1 })
    await database.collection('asistenciaAlertas').createIndex({ companyId: 1, usuarioAfectadoId: 1 })
    await database.collection('faceVerificationLogs').createIndex({ createdAt: -1 })
    console.log('[mongo][academia] Índices académicos creados/verificados')
  } catch (error) {
    console.warn('[mongo][academia] Error creando índices (no crítico):', error)
  }
}

/** Asegura los índices UNA sola vez por proceso (el pool es compartido). */
let indexesEnsured: Promise<void> | null = null

/** Handle `Db` de academia sobre el pool único, asegurando índices la 1ª vez. */
export async function connectMongo(): Promise<Db> {
  const db = await coreDb(DOMAIN)
  if (!indexesEnsured) {
    indexesEnsured = createIndexes(db).catch((error) => {
      // Si falla, se permite reintentar en la próxima conexión.
      indexesEnsured = null
      throw error
    })
  }
  await indexesEnsured
  return db
}

export function getDb(): Promise<Db> {
  return connectMongo()
}

/**
 * No-op deliberado: la conexión es COMPARTIDA con los demás dominios, así que
 * academia no debe cerrar el pool. Se conserva por compatibilidad de API.
 */
export async function closeMongo(): Promise<void> {
  /* El pool lo gestiona core/mongo.ts */
}

export function getCompaniesCollection(): Promise<Collection<Company>> {
  return connectMongo().then((d) => d.collection<Company>('companies'))
}
export function getUsersCollection(): Promise<Collection<User>> {
  return connectMongo().then((d) => d.collection<User>('users'))
}
export function getLocationsCollection(): Promise<Collection<Location>> {
  return connectMongo().then((d) => d.collection<Location>('locations'))
}
export function getUserInvitationsCollection(): Promise<Collection<UserInvitation>> {
  return connectMongo().then((d) => d.collection<UserInvitation>('userInvitations'))
}
export function getSubjectsCollection(): Promise<Collection<Subject>> {
  return connectMongo().then((d) => d.collection<Subject>('subjects'))
}
export function getAcademicCoursesCollection(): Promise<Collection<AcademicCourse>> {
  return connectMongo().then((d) => d.collection<AcademicCourse>('academicCourses'))
}
export function getAcademicGroupsCollection(): Promise<Collection<AcademicGroup>> {
  return connectMongo().then((d) => d.collection<AcademicGroup>('academicGroups'))
}
export function getClassSessionsCollection(): Promise<Collection<ClassSession>> {
  return connectMongo().then((d) => d.collection<ClassSession>('classSessions'))
}
export function getStudentAttendancesCollection(): Promise<Collection<StudentAttendance>> {
  return connectMongo().then((d) => d.collection<StudentAttendance>('studentAttendances'))
}
export function getInstructorAttendancesCollection(): Promise<Collection<InstructorAttendance>> {
  return connectMongo().then((d) => d.collection<InstructorAttendance>('instructorAttendances'))
}
export function getJustificacionesCollection(): Promise<Collection<Justificacion>> {
  return connectMongo().then((d) => d.collection<Justificacion>('justificaciones'))
}
export function getAcademicEventsCollection(): Promise<Collection<AcademicEvent>> {
  return connectMongo().then((d) => d.collection<AcademicEvent>('academicEvents'))
}
export function getAsistenciaAlertasCollection(): Promise<Collection<AsistenciaAlerta>> {
  return connectMongo().then((d) => d.collection<AsistenciaAlerta>('asistenciaAlertas'))
}
export function getFaceVerificationLogsCollection(): Promise<Collection<FaceVerificationLog>> {
  return connectMongo().then((d) => d.collection<FaceVerificationLog>('faceVerificationLogs'))
}
