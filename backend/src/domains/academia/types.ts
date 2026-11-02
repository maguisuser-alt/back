/**
 * Tipos del backend de Academia (planificación de horarios de clases, cursos,
 * alumnos y profesores). Producto independiente — sólo gestión académica.
 */

// ── Roles y autenticación ────────────────────────────────────────────────────

export type UserRole = 'root' | 'admin' | 'docente' | 'estudiante' | 'supervisor'

export type AuthUser = {
  userId: string
  companyId: string
  role: UserRole
}

export const rolesByCompany: UserRole[] = ['admin', 'docente', 'estudiante', 'supervisor']

// ── Enumeraciones de dominio ─────────────────────────────────────────────────

export type AsistenciaEstado = 'presente' | 'ausente' | 'tardanza' | 'justificado' | 'excusa_pendiente'
export type JustificacionEstado = 'pendiente' | 'aprobada' | 'rechazada'
export type IngresoValidacion = 'pendiente' | 'validado' | 'rechazado' | 'biometrico_ok' | 'qr_ok'
export type DiaSemana = 'lunes' | 'martes' | 'miercoles' | 'jueves' | 'viernes' | 'sabado' | 'domingo'
export type EventoTipo = 'clase' | 'taller' | 'evento' | 'evaluacion' | 'reunion'
export type AlertaTipo = 'faltas_consecutivas' | 'inasistencia_alta' | 'tardanzas_repetidas' | 'sin_confirmacion_docente'

export type AccessModule =
  | 'dashboard'
  | 'asistencia-clase'
  | 'codigo-qr'
  | 'asistencia-docente'
  | 'porcentaje-asistencia'
  | 'justificaciones'
  | 'alertas-inasistencia'
  | 'eventos-talleres'
  | 'gestionar-cursos'
  | 'gestionar-asignaturas'
  | 'gestionar-grupos-academicos'
  | 'confirmar-asistencia-clase'
  | 'registrar-ingreso'
  | 'validar-ingresos'
  | 'informes'
  | 'configuracion'

export type PermissionLevel = 'none' | 'view' | 'edit' | 'full'

/** Prueba de vida / liveness para anti-spoofing biométrico */
export type LivenessChallenge =
  | { tipo: 'parpadeo'; requerido: boolean; detectado?: boolean; probabilidad?: number }
  | { tipo: 'sonrisa'; requerido: boolean; detectado?: boolean; probabilidad?: number }
  | { tipo: 'giro_izq'; requerido: boolean; detectado?: boolean; angulo?: number }
  | { tipo: 'giro_der'; requerido: boolean; detectado?: boolean; angulo?: number }
  | { tipo: 'hablar'; requerido: boolean; detectado?: boolean; texto?: string }

// ── Institución (academia) ───────────────────────────────────────────────────

export type CompanySettings = {
  requireBiometric?: boolean
  requirePhoto?: boolean
  requireLocationValidation?: boolean
  timezone?: string
  /** Minutos de tolerancia de ingreso antes de contar tardanza. */
  toleranciaIngresoMin?: number
  /** % máximo de inasistencia permitido. */
  maxInasistenciaPorcentaje?: number
  /** Duración del bloque de clase en minutos. */
  duracionBloque?: number
  /** Nº de faltas consecutivas que dispara una alerta. */
  alertaFaltasConsecutivas?: number
  /** Si exige documento soporte para excusas médicas. */
  requiereExcusaFormal?: boolean
  /** Si habilita el QR dinámico de sesión. */
  habilitarQrDinamico?: boolean
}

export type Company = {
  id: string
  /** ID de la compañía en el producto de turnos (cuando se accede embebido). */
  externalId?: string
  nombre: string
  nit: string
  correo: string
  telefono?: string
  direccion?: string
  ciudad?: string
  /** Siempre 'academia' en este producto. */
  tipo: 'academia'
  enabledModules?: AccessModule[]
  settings: CompanySettings
  activa: boolean
  createdAt: string
}

// ── Usuario (admin / docente / estudiante / supervisor) ──────────────────────

export type StoredWebAuthnCredential = {
  credentialId: string
  publicKey: number[]
  counter: number
  transports?: string[]
  createdAt?: string
}

export type UserBiometricProfile = {
  registeredAt?: string
  credentials: StoredWebAuthnCredential[]
}

export type User = {
  id: string
  companyId: string
  nombreCompleto: string
  tipoDocumento: string
  numeroDocumento: string
  correo: string
  telefono?: string
  cargo: string
  role: UserRole
  positionId?: string
  activa: boolean
  docente?: { codigo?: string; titulo?: string; especialidad?: string }
  estudiante?: { codigo?: string; cursoId?: string; fechaIngreso?: string }
  biometric?: UserBiometricProfile
  /** Descriptor facial legacy (128 floats). */
  faceDescriptor?: number[]
  faceRegisteredAt?: string
  /** Perfil biométrico facial mejorado (multi-descriptor + anti-spoofing). */
  faceProfile?: EnhancedFaceProfile
  allowFaceReRegister?: boolean
  createdAt: string
}

// ── Sedes / ubicaciones ──────────────────────────────────────────────────────

export type Location = {
  id: string
  companyId: string
  nombre: string
  direccion?: string
  latitud?: string
  longitud?: string
  radioTolerancia?: string
  descripcion?: string
  createdAt: string
}

// ── Invitaciones (auto-registro de alumnos a un grupo) ───────────────────────

export type InvitationStatus = 'pendiente' | 'completada' | 'cancelada'

export type UserInvitation = {
  id: string
  token: string
  companyId: string
  positionId?: string
  cargo: string
  role: UserRole
  status: InvitationStatus
  invitedByUserId: string
  invitedUserId?: string
  academicGroupId?: string
  academicGroupNombre?: string
  expiresAt?: string
  createdAt: string
  completedAt?: string
}

// ── Asignaturas, cursos, grupos, horarios ────────────────────────────────────

export type Subject = {
  id: string
  companyId: string
  codigo: string
  nombre: string
  descripcion?: string
  categoria?: string
  creditos?: number
  horasAcademicas?: number
  activa: boolean
  createdAt: string
}

export type AcademicCourse = {
  id: string
  companyId: string
  codigo: string
  nombre: string
  descripcion?: string
  duracionMeses?: number
  nivel?: string
  activo: boolean
  createdAt: string
}

export type AcademicGroupTeacher = {
  docenteUserId: string
  docenteNombre: string
  subjectId: string
  subjectNombre: string
  categoria?: string
}

export type HorarioFranja = {
  dia: DiaSemana
  horaInicio: string
  horaFin: string
  docenteUserId: string
  docenteNombre?: string
  subjectId: string
  subjectNombre?: string
  categoria?: string
  ubicacionId?: string
  ubicacionNombre?: string
}

export type AcademicGroup = {
  id: string
  companyId: string
  nombre: string
  codigo: string
  courseId?: string
  courseNombre?: string
  subjectId: string
  subjectNombre: string
  docenteUserId: string
  docenteNombre: string
  docentes?: AcademicGroupTeacher[]
  horario?: HorarioFranja[]
  estudianteUserIds: string[]
  ubicacionId?: string
  ubicacionNombre?: string
  diasSemana: DiaSemana[]
  horaInicio: string
  horaFin: string
  fechaInicio?: string
  fechaFin?: string
  activo: boolean
  createdAt: string
  updatedAt: string
}

export type ClassSession = {
  id: string
  companyId: string
  academicGroupId: string
  academicGroupNombre?: string
  subjectId: string
  subjectNombre?: string
  docenteUserId: string
  docenteNombre?: string
  fecha: string
  horaInicio: string
  horaFin?: string
  ubicacionId?: string
  ubicacionNombre?: string
  tema?: string
  observaciones?: string
  estado: 'programada' | 'en_curso' | 'finalizada' | 'cancelada'
  esVirtual?: boolean
  tipoEvento?: EventoTipo
  toleranciaIngresoMin?: number
  docenteAsistencia?: {
    marcado: boolean
    marcadoA?: string
    metodo?: 'qr' | 'biometrico_facial' | 'pin' | 'manual'
    validadoPor?: string
    horaLlegada?: string
    horaSalida?: string
    horasCatedra?: number
  }
  qrToken?: string
  qrPayload?: string
  qrExpiracion?: string
  qrGeneradoA?: string
  asistenciaResumen?: {
    totalEstudiantes: number
    presentes: number
    ausentes: number
    tardanzas: number
    justificados: number
    porcentajeConfirmado: number
  }
  createdAt: string
  updatedAt: string
}

export type StudentAttendance = {
  id: string
  companyId: string
  sessionId: string
  academicGroupId: string
  subjectId: string
  fecha: string
  estudianteUserId: string
  estudianteNombre: string
  estado: AsistenciaEstado
  horaIngreso?: string
  metodo?: 'qr' | 'biometrico_facial' | 'manual_docente' | 'manual_admin'
  confirmadoPorDocente?: boolean
  confirmadoPorDocenteA?: string
  docenteValidadorId?: string
  validacionIngreso?: IngresoValidacion
  validadoPorId?: string
  validadoPorNombre?: string
  validadoA?: string
  minutosTardanza?: number
  observaciones?: string
  justificacionId?: string
  createdAt: string
  updatedAt: string
}

export type InstructorAttendance = {
  id: string
  companyId: string
  sessionId: string
  academicGroupId: string
  subjectId: string
  fecha: string
  docenteUserId: string
  docenteNombre: string
  horaLlegada?: string
  horaSalida?: string
  horasCatedraCumplidas?: number
  estado: 'presente' | 'ausente' | 'tardanza' | 'justificado'
  metodoIngreso?: 'qr' | 'biometrico_facial' | 'pin' | 'manual'
  confirmadoPor?: string
  confirmadoPorNombre?: string
  confirmadoA?: string
  validacionIngreso?: IngresoValidacion
  observaciones?: string
  justificacionId?: string
  createdAt: string
  updatedAt: string
}

export type Justificacion = {
  id: string
  companyId: string
  solicitanteUserId: string
  solicitanteNombre: string
  solicitanteRole: UserRole
  tipo: 'medica' | 'institucional' | 'personal' | 'otra'
  motivo: string
  fechasAfectadas: string[]
  sessionIds?: string[]
  documentoUrl?: string
  estado: JustificacionEstado
  revisadoPorId?: string
  revisadoPorNombre?: string
  revisadoA?: string
  respuesta?: string
  createdAt: string
  updatedAt: string
}

export type FaceVerificationLog = {
  id: string
  verified: boolean
  confidence: number
  distance: number
  method: 'login' | 'attendance' | 'ingreso_clase' | 'manual_check'
  referencePhotoUrl?: string
  capturePhotoUrl?: string
  livenessPassed?: boolean
  livenessChallenges?: LivenessChallenge[]
  location?: { lat: number; lng: number; distanceMeters?: number }
  ipAddress?: string
  userAgent?: string
  createdAt: string
}

export type EnhancedFaceProfile = {
  faceDescriptors: Array<{
    descriptor: number[]
    registeredAt: string
    angulo?: 'frente' | 'perfil_izq' | 'perfil_der' | 'arriba' | 'abajo'
    calidad?: number
    photoUrl?: string
  }>
  primaryPhotoUrl?: string
  registeredAt: string
  registeredBy?: string
  lastVerifiedAt?: string
  verificationCount: number
  failedAttempts: number
  lockedUntil?: string
  livenessPassed?: boolean
  livenessLastPassedAt?: string
  livenessChallenges?: LivenessChallenge[]
  avgConfidence?: number
  minConfidence?: number
  maxConfidence?: number
  recentVerifications?: FaceVerificationLog[]
  estado: 'activo' | 'suspendido' | 'pendiente_verificacion' | 'bloqueado'
  requiereReRegistro?: boolean
  motivoReRegistro?: string
  dispositivoRegistro?: {
    userAgent?: string
    ipAddress?: string
    modeloCamara?: string
  }
}

export type AcademicEvent = {
  id: string
  companyId: string
  tipo: EventoTipo
  nombre: string
  descripcion?: string
  fecha: string
  horaInicio: string
  horaFin?: string
  ubicacionId?: string
  ubicacionNombre?: string
  organizadorUserId?: string
  organizadorNombre?: string
  asistentesEsperadosUserIds?: string[]
  subjectId?: string
  subjectNombre?: string
  academicGroupIds?: string[]
  requiereAsistencia?: boolean
  qrToken?: string
  qrExpiracion?: string
  estado: 'programado' | 'en_curso' | 'finalizado' | 'cancelado'
  asistenciaTomada?: boolean
  createdAt: string
  updatedAt: string
}

export type AsistenciaAlerta = {
  id: string
  companyId: string
  tipo: AlertaTipo
  nivel: 'info' | 'warning' | 'critical'
  usuarioAfectadoId: string
  usuarioAfectadoNombre: string
  usuarioAfectadoRole: 'estudiante' | 'docente'
  subjectId?: string
  subjectNombre?: string
  academicGroupId?: string
  sessionId?: string
  mensaje: string
  detalles?: Record<string, unknown>
  leida: boolean
  leidaPor?: string
  leidaA?: string
  resuelta?: boolean
  resueltaPor?: string
  resueltaA?: string
  createdAt: string
}

// ── Esquema completo (snapshot en memoria que arma readDatabase) ─────────────

export type DatabaseSchema = {
  companies: Company[]
  users: User[]
  locations: Location[]
  userInvitations: UserInvitation[]
  subjects: Subject[]
  academicCourses: AcademicCourse[]
  academicGroups: AcademicGroup[]
  classSessions: ClassSession[]
  studentAttendances: StudentAttendance[]
  instructorAttendances: InstructorAttendance[]
  justificaciones: Justificacion[]
  academicEvents: AcademicEvent[]
  asistenciaAlertas: AsistenciaAlerta[]
  faceVerificationLogs: FaceVerificationLog[]
}
