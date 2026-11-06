// ── Roles por tipo de gestión ─────────────────────────────────────────────

export type EmpresaRole = 'admin' | 'supervisor' | 'operativo'
export type AcademiaRole = 'admin' | 'docente' | 'estudiante'
export type UserRole = EmpresaRole | AcademiaRole

export const rolesByCompanyType = {
  empresa:  ['admin', 'supervisor', 'operativo'] as UserRole[],
  academia: ['admin', 'docente', 'estudiante'] as UserRole[],
}

export const defaultPermissionsByRole: Record<UserRole, { empresa: AccessModule[]; academia: AccessModule[] }> = {
  admin: {
    empresa: ['dashboard', 'turnos-fijos', 'turnos-rotativos', 'horas-extras-recargos', 'geolocalizacion', 'permisos-ausencias', 'biometria-facial', 'teletrabajo', 'facturacion', 'informes', 'configuracion', 'crear-cargos', 'crear-ubicaciones', 'invitar-empleados', 'editar-empleados', 'eliminar-empleados', 'editar-turnos', 'eliminar-turnos'],
    academia: ['dashboard', 'asistencia-clase', 'codigo-qr', 'asistencia-docente', 'porcentaje-asistencia', 'justificaciones', 'alertas-inasistencia', 'eventos-talleres', 'informes', 'configuracion', 'gestionar-cursos', 'gestionar-asignaturas', 'gestionar-grupos-academicos', 'validar-ingresos'],
  },
  supervisor: {
    empresa: ['dashboard', 'turnos-fijos', 'geolocalizacion', 'biometria-facial', 'informes'],
    academia: ['dashboard', 'asistencia-clase', 'asistencia-docente', 'informes', 'validar-ingresos'],
  },
  operativo: {
    empresa: ['dashboard', 'turnos-fijos'],
    academia: ['dashboard'],
  },
  docente: {
    empresa: ['dashboard'],
    academia: ['dashboard', 'asistencia-clase', 'codigo-qr', 'porcentaje-asistencia', 'justificaciones', 'eventos-talleres', 'confirmar-asistencia-clase'],
  },
  estudiante: {
    empresa: ['dashboard'],
    academia: ['dashboard', 'codigo-qr', 'porcentaje-asistencia', 'justificaciones', 'registrar-ingreso'],
  },
}

export type TurnStatus = 'pendiente' | 'asignado' | 'en_proceso' | 'finalizado' | 'confirmado' | 'rechazado' | 'no_aprobado'
export type InvitationStatus = 'pendiente' | 'completada' | 'cancelada'
export type AttendanceAction = 'entrada' | 'salida'
export type CompanyType = 'empresa' | 'academia'

// ── Tipos específicos de Academia ────────────────────────────────────────────

export type AsistenciaEstado = 'presente' | 'ausente' | 'tardanza' | 'justificado' | 'excusa_pendiente'
export type JustificacionEstado = 'pendiente' | 'aprobada' | 'rechazada'
export type IngresoValidacion = 'pendiente' | 'validado' | 'rechazado' | 'biometrico_ok' | 'qr_ok'
export type DiaSemana = 'lunes' | 'martes' | 'miercoles' | 'jueves' | 'viernes' | 'sabado' | 'domingo'
export type EventoTipo = 'clase' | 'taller' | 'evento' | 'evaluacion' | 'reunion'
export type AlertaTipo = 'faltas_consecutivas' | 'inasistencia_alta' | 'tardanzas_repetidas' | 'sin_confirmacion_docente'

/** Prueba de vida / liveness para anti-spoofing biométrico */
export type LivenessChallenge =
  | { tipo: 'parpadeo'; requerido: boolean; detectado?: boolean; probabilidad?: number }
  | { tipo: 'sonrisa'; requerido: boolean; detectado?: boolean; probabilidad?: number }
  | { tipo: 'giro_izq'; requerido: boolean; detectado?: boolean; angulo?: number }
  | { tipo: 'giro_der'; requerido: boolean; detectado?: boolean; angulo?: number }
  | { tipo: 'hablar'; requerido: boolean; detectado?: boolean; texto?: string }

/** Asignatura / materia académica */
export type Subject = {
  id: string
  companyId: string
  codigo: string
  nombre: string
  descripcion?: string
  /** Categoría/área de la asignatura (ej. Matemáticas, Idiomas, Ciencias). Sirve para agrupar docentes. */
  categoria?: string
  creditos?: number
  horasAcademicas?: number
  activa: boolean
  createdAt: string
}

/** Programa / curso / carrera */
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

/** Docente asignado a un grupo, con la materia (y su categoría) que dicta. */
export type AcademicGroupTeacher = {
  docenteUserId: string
  docenteNombre: string
  subjectId: string
  subjectNombre: string
  categoria?: string
}

/** Franja de horario semanal: un día + hora + docente/materia + sede. */
export type HorarioFranja = {
  dia: DiaSemana
  horaInicio: string
  horaFin: string
  docenteUserId: string
  docenteNombre?: string
  subjectId: string
  subjectNombre?: string
  categoria?: string
  /** Sede donde se dicta esta franja (opcional; si no, se usa la del grupo). */
  ubicacionId?: string
  ubicacionNombre?: string
}

/** Grupo académico: estudiantes + docentes + asignaturas + horario semanal */
export type AcademicGroup = {
  id: string
  companyId: string
  nombre: string
  codigo: string
  courseId?: string
  courseNombre?: string
  /** Materia principal (compat.). Con multi-docente se toma del primer docente. */
  subjectId: string
  subjectNombre: string
  /** Docente principal (compat.). Con multi-docente es el primero de `docentes`. */
  docenteUserId: string
  docenteNombre: string
  /** Docentes asignados al grupo, cada uno con su materia. */
  docentes?: AcademicGroupTeacher[]
  /** Horario semanal estructurado (franjas por día con docente/materia). */
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

/** Sesión de clase programada */
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
  /** Clase virtual: omite la validación de ubicación/sede al marcar asistencia. */
  esVirtual?: boolean
  /** Tipo de sesión / evento */
  tipoEvento?: EventoTipo
  /** Ventana de tolerancia de ingreso (minutos después de horaInicio) */
  toleranciaIngresoMin?: number
  /** Confirmación del docente de que dio la clase */
  docenteAsistencia?: {
    marcado: boolean
    marcadoA?: string
    metodo?: 'qr' | 'biometrico_facial' | 'pin' | 'manual'
    validadoPor?: string
    horaLlegada?: string
    horaSalida?: string
    horasCatedra?: number
  }
  /** QR dinámico de la sesión (con hash firmado) */
  qrToken?: string
  qrPayload?: string
  qrExpiracion?: string
  qrGeneradoA?: string
  /** Resumen rápido de asistencia para listados */
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

/** Registro de asistencia de un estudiante en una sesión */
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
  /** Hora exacta en que registró ingreso */
  horaIngreso?: string
  /** Método de registro */
  metodo?: 'qr' | 'biometrico_facial' | 'manual_docente' | 'manual_admin'
  /** Confirmación / validación del docente (requerida para oficializar) */
  confirmadoPorDocente?: boolean
  confirmadoPorDocenteA?: string
  docenteValidadorId?: string
  /** Validación de ingreso por ubicación / coordinación */
  validacionIngreso?: IngresoValidacion
  validadoPorId?: string
  validadoPorNombre?: string
  validadoA?: string
  /** Tiempo de tardanza en minutos */
  minutosTardanza?: number
  /** Observaciones */
  observaciones?: string
  /** Si fue reemplazado por una justificación */
  justificacionId?: string
  createdAt: string
  updatedAt: string
}

/** Asistencia del docente / instructor a su sesión */
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
  /** Confirmación del supervisor / coordinador */
  confirmadoPor?: string
  confirmadoPorNombre?: string
  confirmadoA?: string
  validacionIngreso?: IngresoValidacion
  observaciones?: string
  justificacionId?: string
  createdAt: string
  updatedAt: string
}

/** Justificación de inasistencia (estudiante o docente) */
export type Justificacion = {
  id: string
  companyId: string
  solicitanteUserId: string
  solicitanteNombre: string
  solicitanteRole: UserRole
  tipo: 'medica' | 'institucional' | 'personal' | 'otra'
  motivo: string
  /** Lista de fechas o sesiones que justifica */
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

/** Registro individual de verificación facial */
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

/** Perfil biométrico facial mejorado — múltiples fotos de referencia + anti-spoofing */
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
  /** Anti-spoofing: se requirió prueba de vida (parpadeo, sonrisa, giro) */
  livenessPassed?: boolean
  livenessLastPassedAt?: string
  livenessChallenges?: LivenessChallenge[]
  /** Nivel de confianza promedio en verificaciones */
  avgConfidence?: number
  minConfidence?: number
  maxConfidence?: number
  /** Historial reciente de verificaciones (últimas N) */
  recentVerifications?: FaceVerificationLog[]
  /** Estado del perfil */
  estado: 'activo' | 'suspendido' | 'pendiente_verificacion' | 'bloqueado'
  /** Si requiere re-registro forzado por el admin */
  requiereReRegistro?: boolean
  motivoReRegistro?: string
  /** Metadata del dispositivo usado para registrar */
  dispositivoRegistro?: {
    userAgent?: string
    ipAddress?: string
    modeloCamara?: string
  }
}

/** Evento / taller académico (fuera de las sesiones de clase regulares) */
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

/** Alerta generada automáticamente por reglas de asistencia */
export type AsistenciaAlerta = {
  id: string
  companyId: string
  tipo: AlertaTipo
  nivel: 'info' | 'warning' | 'critical'
  /** Usuario afectado: estudiante o docente */
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

/** Resumen periódico de asistencia para reportes */
export type AsistenciaResumenPeriodo = {
  companyId: string
  periodoInicio: string
  periodoFin: string
  usuarioId?: string
  subjectId?: string
  academicGroupId?: string
  totalSesiones: number
  sesionesAsistidas: number
  sesionesAusente: number
  sesionesTardanza: number
  sesionesJustificadas: number
  porcentajeAsistencia: number
  porcentajeTardanzas: number
  faltasConsecutivasActuales: number
  maxFaltasConsecutivas: number
  alertasGeneradas: number
  lastUpdated: string
}

// ── Módulos por tipo de gestión ──────────────────────────────────────────────

export type EmpresaModule =
  | 'dashboard'
  | 'turnos-fijos'
  | 'turnos-rotativos'
  | 'horas-extras-recargos'
  | 'geolocalizacion'
  | 'permisos-ausencias'
  | 'biometria-facial'
  | 'teletrabajo'
  | 'facturacion'
  | 'informes'
  | 'configuracion'
  | 'trazabilidad'
  | 'academia'
  | 'whatsapp-turnos'
  | 'crear-cargos'
  | 'crear-ubicaciones'
  | 'invitar-empleados'
  | 'editar-empleados'
  | 'eliminar-empleados'
  | 'editar-turnos'
  | 'eliminar-turnos'

export type AcademiaModule =
  | 'dashboard'
  | 'asistencia-clase'
  | 'codigo-qr'
  | 'asistencia-docente'
  | 'porcentaje-asistencia'
  | 'justificaciones'
  | 'alertas-inasistencia'
  | 'eventos-talleres'
  | 'informes'
  | 'configuracion'
  | 'whatsapp-turnos'
  | 'gestionar-cursos'
  | 'gestionar-asignaturas'
  | 'gestionar-grupos-academicos'
  | 'confirmar-asistencia-clase'
  | 'registrar-ingreso'
  | 'validar-ingresos'

export type AccessModule = EmpresaModule | AcademiaModule

export type StoredWebAuthnCredential = {
  id: string
  publicKey: number[]
  counter: number
  transports?: string[]
  createdAt: string
  lastUsedAt?: string
}

export type UserBiometricProfile = {
  credentials: StoredWebAuthnCredential[]
  registrationChallenge?: string
  authenticationChallenge?: string
  pendingRpId?: string
  pendingTurnId?: string
  pendingAttendanceAction?: AttendanceAction
}

export type AttendanceLocationCheck = {
  latitude: number
  longitude: number
  distanceMeters: number
  allowedRadiusMeters: number
  withinRange: boolean
  locationId: string
  locationNombre?: string
  verifiedAt: string
}

export type AttendanceRecord = {
  action: AttendanceAction
  markedAt: string
  method: 'webauthn' | 'pin' | 'auto'
  credentialId: string
  locationCheck: AttendanceLocationCheck
  facialPhotoUrl?: string
}

export type TurnAttendance = {
  checkIn?: AttendanceRecord
  checkOut?: AttendanceRecord
}

export type CompanySettings = {
  // ── Comunes ──────────────────────────────────────────────
  requireBiometric: boolean
  requirePhoto: boolean
  requireLocationValidation: boolean
  allowAutoCloseMinutes: number
  defaultConfirmHoursLimit: number
  timezone: string

  // ── Empresa ──────────────────────────────────────────────
  billingRateDefault?: number          // Tarifa hora por defecto
  recargoNocturno?: number             // % recargo nocturno (default 35)
  recargoDominical?: number            // % recargo dominical (default 75)
  recargoFestivo?: number              // % recargo festivo (default 100)
  jornadaOrdinaria?: number            // Horas jornada ordinaria (default 8)
  permitirTeletrabajo?: boolean        // Habilita fichaje remoto
  permitirPermutaTurnos?: boolean      // Permite cambio de turnos entre empleados
  recordatorioMinutosAntes?: number    // Minutos antes del inicio para avisar por WhatsApp (default 60)
  autoCloseGraceMinutes?: number       // Minutos tras horaFin para autocerrar un turno sin salida (default 120)
  nocturnoInicioHora?: number          // Hora local en que inicia el horario nocturno (default 19)
  nocturnoFinHora?: number             // Hora local en que termina el horario nocturno (default 6)

  // ── Academia ─────────────────────────────────────────────
  maxInasistenciaPorcentaje?: number   // % máximo de faltas antes de perder materia (default 20)
  duracionBloque?: number              // Minutos por bloque académico (default 45)
  alertaFaltasConsecutivas?: number    // Nº de faltas para activar alerta (default 3)
  requiereExcusaFormal?: boolean       // Exige documento de excusa para justificar
  habilitarQrDinamico?: boolean        // QR cambiante por clase
  toleranciaIngresoMin?: number        // Minutos de tolerancia antes de marcar tardanza (default 15)
  maxTardanzaSinFaltaMin?: number      // Max minutos de tardanza antes de marcar falta (default 30)
  requiereConfirmacionDocente?: boolean // La asistencia del estudiante requiere visto bueno del docente
  habilitarLivenessDetection?: boolean // Requerir prueba de vida (anti-spoofing) en ingreso biométrico

  // ── Trazabilidad (subconfiguración del microfrontend) ───
  trazabilidadSettings?: {
    activityLog?: boolean        // Mostrar registro de actividades en la pantalla principal
    sendEmail?: boolean          // Enviar registros completados por correo electrónico
    emailTo?: string             // Correo(s) destinatario(s) separados por coma
    whatsappUnified?: boolean    // Usar el mismo WhatsApp de turnos para trazabilidad
    whatsappAudio?: boolean      // Habilitar grabación de audio en los registros
    whatsappCatalog?: boolean    // Habilitar adjuntar catálogo en los registros
    whatsappDocument?: boolean   // Habilitar adjuntar documentos en los registros
    markerEditor?: boolean       // Habilitar editor de imágenes con marcador
    registrarActividad?: boolean // Habilitar opción de registrar actividad en operaciones
  }
}

export type Company = {
  id: string
  nombre: string
  nit: string
  correo: string
  telefono?: string
  direccion?: string
  ciudad?: string
  tipo: CompanyType
  enabledModules: AccessModule[]
  settings: CompanySettings
  activa: boolean
  createdAt: string
}

export type PermissionLevel = 'none' | 'view' | 'edit' | 'full'

export type Position = {
  id: string
  companyId: string
  nombre: string
  descripcion?: string
  permissions: AccessModule[]
  permissionLevels?: Record<string, PermissionLevel>  // module → 'view' | 'edit'
  valorHora?: number
  activa: boolean
  createdAt: string
}

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
  /** Hash bcrypt de la contraseña de acceso (opcional; el login principal es por documento). */
  passwordHash?: string
  biometric?: UserBiometricProfile
  faceDescriptor?: number[]           // Legacy: descriptor único
  faceRegisteredAt?: string           // Legacy: fecha de registro
  allowFaceReRegister?: boolean       // Admin can set to true to allow re-registration
  /** Perfil biométrico mejorado — múltiples descriptores + anti-spoofing */
  faceProfile?: EnhancedFaceProfile
  /** Datos específicos si es estudiante */
  estudiante?: {
    codigo?: string
    cursoId?: string
    fechaIngreso?: string
  }
  /** Datos específicos si es docente */
  docente?: {
    codigo?: string
    titulo?: string
    especialidad?: string
  }
  createdAt: string
}

export type TurnNovedad = {
  id: string
  tipo: 'ingreso' | 'durante' | 'salida' | 'rechazo'
  descripcion: string
  reportadoPor: string                 // userId del supervisor
  reportadoPorNombre?: string
  createdAt: string
}

export type Turn = {
  id: string
  companyId: string
  titulo: string
  descripcion?: string
  fecha: string
  hora: string
  horaFin?: string
  estado: TurnStatus
  creadoPorUserId: string
  assignedToUserId?: string
  assignedToUserName?: string
  locationId?: string
  locationNombre?: string
  confirmedDeadline?: string
  confirmHoursLimit?: number          // Horas antes del turno para confirmar (default 4)
  rejectionReason?: string
  confirmedByUserId?: string          // Supervisor que confirmó
  confirmedByUserName?: string
  confirmedAt?: string                // Fecha/hora de confirmación
  reminderSentAt?: string             // Cuándo se envió el recordatorio por WhatsApp (evita duplicados)
  novedades?: TurnNovedad[]           // Reportes de novedades del supervisor
  attendance?: TurnAttendance
  createdAt: string
  updatedAt: string
}

/** Estados de una permuta: propuesta → aceptada por el compañero → aprobada por supervisor. */
export type TurnSwapStatus = 'pendiente_companero' | 'pendiente_aprobacion' | 'aprobada' | 'rechazada' | 'cancelada'

export type TurnSwap = {
  id: string
  companyId: string
  /** Turno que cede quien propone. */
  turnId: string
  requesterUserId: string
  requesterUserName: string
  /** Turno del compañero que se recibe a cambio. */
  targetTurnId: string
  targetUserId: string
  targetUserName: string
  motivo?: string
  estado: TurnSwapStatus
  respondedAt?: string
  resolvedByUserId?: string
  resolvedByUserName?: string
  resolvedAt?: string
  rejectionReason?: string
  createdAt: string
  updatedAt: string
}

export type UserInvitation = {
  id: string
  token: string
  companyId: string
  positionId?: string                 // opcional para invitaciones académicas
  cargo: string
  role: UserRole
  status: InvitationStatus
  invitedByUserId: string
  invitedUserId?: string
  /** Si la invitación es para unirse a un grupo académico (rol estudiante). */
  academicGroupId?: string
  academicGroupNombre?: string
  expiresAt: string                   // ISO date — link expira después de 1 hora
  createdAt: string
  completedAt?: string
}

export type DatabaseSchema = {
  companies: Company[]
  users: User[]
  positions: Position[]
  locations: Location[]
  turns: Turn[]
  userInvitations: UserInvitation[]
  horasTurno: HorasTurnoRecord[]
  facturas: Factura[]
  groups: OperationGroup[]
  // ── Academia ──────────────────────────────────────────────
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

/**
 * Grupo operativo — agrupa empleados por zona y horario.
 * Permite crear turnos en bloque y gestionar personal.
 */
export type OperationGroup = {
  id: string
  companyId: string
  nombre: string                      // Ej. "Turno Mañana - Bodega Norte"
  locationId: string                  // Punto de operación
  locationNombre?: string
  horario: string                     // HH:MM inicio
  horarioFin?: string                 // HH:MM fin
  memberUserIds: string[]             // IDs de empleados del grupo
  supervisorUserId?: string           // Supervisor asignado al grupo
  activo: boolean
  createdAt: string
  updatedAt: string
}

export type HorasTurnoRecord = {
  id: string
  companyId: string
  facturaId?: string
  turnId: string
  userId: string
  nombreUsuario: string
  cargo: string
  locationId?: string
  nombreUbicacion?: string
  fecha: string
  diaSemana: string                    // 'lunes' | 'martes' | ... | 'domingo'
  esDominical: boolean                 // true si es domingo
  esFestivo: boolean                   // true si es día festivo
  horaEntradaEsperada: string
  horaSalidaEsperada?: string
  horaEntradaReal?: string
  horaSalidaReal?: string
  horasTrabajadas: number              // Total horas del turno
  horasOrdinarias: number              // Horas en día laboral normal
  horasDominicales: number             // Horas en domingo
  horasFestivas: number                // Horas en festivo
  horasNocturnas?: number              // Horas dentro del horario nocturno (informativo + recargo)
  horasExtra?: number                  // Horas por encima de la jornada ordinaria
  recargoNocturno?: number             // % recargo nocturno aplicado
  subtotalNocturno?: number            // Recargo nocturno: horasNocturnas × valorHora × recargoNocturno/100
  metodoSalida?: 'webauthn' | 'pin' | 'auto'
  valorHora?: number                   // Tarifa hora ordinaria
  recargoDominical?: number            // % recargo dominical (default 75%)
  recargoFestivo?: number              // % recargo festivo (default 100%)
  subtotalOrdinario?: number           // horasOrdinarias × valorHora
  subtotalDominical?: number           // horasDominicales × valorHora × (1 + recargoDominical/100)
  subtotalFestivo?: number             // horasFestivas × valorHora × (1 + recargoFestivo/100)
  subtotal?: number                    // Suma de los tres subtotales
  estadoTurno: string
  confirmadoPor?: string
  createdAt: string
}

export type FacturaEstado = 'borrador' | 'emitida' | 'pagada' | 'anulada'

export type Factura = {
  id: string
  companyId: string
  periodoMes: string
  fechaGeneracion: string
  totalHoras: number
  totalHorasOrdinarias: number
  totalHorasDominicales: number
  totalHorasFestivas: number
  totalValorOrdinario: number
  totalValorDominicales: number
  totalValorFestivos: number
  totalValor: number
  moneda: string
  recargoDominical: number             // % aplicado (default 75)
  recargoFestivo: number               // % aplicado (default 100)
  estado: FacturaEstado
  observaciones?: string
  generadoPor: string
  createdAt: string
}

export type AuthUser = {
  userId: string
  companyId: string
  role: UserRole | 'root'
}
