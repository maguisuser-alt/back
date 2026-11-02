/**
 * Acceso a MongoDB del dominio TURNOS.
 *
 * Shim que delega TODO en la capa única ../../core/mongo.ts (un solo
 * MongoClient para todo el backend). Los nombres de base y de colección son
 * idénticos a los que usaba back-turnos: la base de datos queda intacta.
 *
 * Se conserva la firma asíncrona original (getDb(): Promise<Db>) para no
 * tener que tocar ninguna ruta.
 */
import type { Collection, Db, Document } from 'mongodb'
import { getDb as coreDb, closeMongo as coreClose } from '../../../core/mongo.js'
import type {
  AcademicCourse,
  AcademicEvent,
  AcademicGroup,
  AsistenciaAlerta,
  ClassSession,
  Company,
  Factura,
  FaceVerificationLog,
  HorasTurnoRecord,
  InstructorAttendance,
  Justificacion,
  Location,
  OperationGroup,
  Position,
  StudentAttendance,
  Subject,
  Turn,
  User,
  UserInvitation,
} from '../types.js'

const DOMAIN = 'turnos' as const

const col = <T extends Document>(name: string): Promise<Collection<T>> =>
  coreDb(DOMAIN).then((db) => db.collection<T>(name))

/** Conexión (lazy, idempotente) al pool compartido. */
export async function connectMongo(): Promise<Db> {
  return coreDb(DOMAIN)
}

export function getDb(): Promise<Db> {
  return coreDb(DOMAIN)
}

/** El pool es compartido: cerrarlo afectaría a todos los dominios. */
export async function closeMongo(): Promise<void> {
  return coreClose()
}

// ── Colecciones de turnos ──
export const getCompaniesCollection = () => col<Company>('companies')
export const getUsersCollection = () => col<User>('users')
export const getPositionsCollection = () => col<Position>('positions')
export const getLocationsCollection = () => col<Location>('locations')
export const getTurnsCollection = () => col<Turn>('turns')
export const getUserInvitationsCollection = () => col<UserInvitation>('userInvitations')
export const getHorasTurnoCollection = () => col<HorasTurnoRecord>('horasTurno')
export const getFacturasCollection = () => col<Factura>('facturas')
export const getGroupsCollection = () => col<OperationGroup>('groups')

// ── Colecciones de academia (históricamente servidas por back-turnos) ──
export const getSubjectsCollection = () => col<Subject>('subjects')
export const getAcademicCoursesCollection = () => col<AcademicCourse>('academicCourses')
export const getAcademicGroupsCollection = () => col<AcademicGroup>('academicGroups')
export const getClassSessionsCollection = () => col<ClassSession>('classSessions')
export const getStudentAttendancesCollection = () => col<StudentAttendance>('studentAttendances')
export const getInstructorAttendancesCollection = () => col<InstructorAttendance>('instructorAttendances')
export const getJustificacionesCollection = () => col<Justificacion>('justificaciones')
export const getAcademicEventsCollection = () => col<AcademicEvent>('academicEvents')
export const getAsistenciaAlertasCollection = () => col<AsistenciaAlerta>('asistenciaAlertas')
export const getFaceVerificationLogsCollection = () => col<FaceVerificationLog>('faceVerificationLogs')
