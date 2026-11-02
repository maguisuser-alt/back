export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Ommex Turnos API',
    version: '1.0.0',
    description:
      'API para registro de empresas, autenticacion, usuarios operativos, puestos y asignacion de turnos.',
  },
  servers: [
    {
      url: 'http://localhost:4000',
      description: 'Servidor local',
    },
  ],
  tags: [
    { name: 'Health', description: 'Verificacion del servicio' },
    { name: 'Auth', description: 'Registro y autenticacion' },
    { name: 'Attendance', description: 'Asistencia biometrica y validacion de ubicacion' },
    { name: 'Companies', description: 'Consultas de empresa autenticada' },
    { name: 'Locations', description: 'Ubicaciones o puntos de operacion' },
    { name: 'Messages', description: 'Generacion de enlaces para mensajeria' },
    { name: 'Positions', description: 'Puestos operativos' },
    { name: 'Users', description: 'Usuarios vinculados a la empresa' },
    { name: 'Turns', description: 'Creacion y asignacion de turnos' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      RegisterCompanyRequest: {
        type: 'object',
        required: [
          'empresa',
          'nit',
          'correoEmpresa',
          'adminNombreCompleto',
          'adminCorreo',
          'adminTelefono',
          'adminTipoDocumento',
          'adminNumeroDocumento',
        ],
        properties: {
          empresa: { type: 'string', example: 'Clinica Ommex SAS' },
          nit: { type: 'string', example: '900123456-7' },
          correoEmpresa: { type: 'string', example: 'contacto@ommex.com' },
          telefonoEmpresa: { type: 'string', example: '6011234567' },
          direccionEmpresa: { type: 'string', example: 'Calle 10 # 20-30' },
          ciudadEmpresa: { type: 'string', example: 'Bogota' },
          adminNombreCompleto: { type: 'string', example: 'Ana Maria Torres' },
          adminCorreo: { type: 'string', example: 'admin@ommex.com' },
          adminTelefono: { type: 'string', example: '3001234567' },
          adminTipoDocumento: { type: 'string', example: 'cc' },
          adminNumeroDocumento: { type: 'string', example: '1012345678' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['numeroDocumento'],
        properties: {
          numeroDocumento: {
            type: 'string',
            example: '1012345678',
            description: 'Numero de documento del usuario',
          },
        },
      },
      PositionRequest: {
        type: 'object',
        required: ['nombre'],
        properties: {
          nombre: { type: 'string', example: 'Recepcionista' },
          descripcion: { type: 'string', example: 'Gestiona recepcion de pacientes' },
        },
      },
      LocationRequest: {
        type: 'object',
        required: ['nombre', 'direccion', 'googleMapsUrl'],
        properties: {
          nombre: { type: 'string', example: 'Sede Norte' },
          direccion: { type: 'string', example: 'Calle 100 # 15-20' },
          googleMapsUrl: {
            type: 'string',
            example: 'https://www.google.com/maps/@4.710989,-74.072092,17z',
          },
          radioTolerancia: { type: 'string', example: '50' },
          descripcion: { type: 'string', example: 'Operacion principal en turno diurno' },
        },
      },
      WhatsAppLinkRequest: {
        type: 'object',
        required: ['phone'],
        properties: {
          phone: {
            type: 'string',
            example: '573001234567',
            description: 'Numero en formato internacional sin espacios ni simbolos.',
          },
          text: {
            type: 'string',
            example: 'Hola, me interesa el servicio',
          },
        },
      },
      AttendanceAuthenticationOptionsRequest: {
        type: 'object',
        required: ['turnId', 'action'],
        properties: {
          turnId: { type: 'string', example: 'turn-1784250000000' },
          action: {
            type: 'string',
            enum: ['entrada', 'salida'],
            example: 'entrada',
          },
        },
      },
      AttendanceAuthenticationVerificationRequest: {
        type: 'object',
        required: ['responseJSON', 'latitude', 'longitude'],
        properties: {
          responseJSON: {
            type: 'object',
            description: 'Respuesta devuelta por startAuthentication() del navegador.',
          },
          latitude: { type: 'number', example: 4.710989 },
          longitude: { type: 'number', example: -74.072092 },
        },
      },
      AttendanceRegistrationVerificationRequest: {
        type: 'object',
        required: ['responseJSON'],
        properties: {
          responseJSON: {
            type: 'object',
            description: 'Respuesta devuelta por startRegistration() del navegador.',
          },
        },
      },
      UserRequest: {
        type: 'object',
        required: [
          'nombreCompleto',
          'tipoDocumento',
          'numeroDocumento',
          'correo',
          'telefono',
          'positionId',
        ],
        properties: {
          nombreCompleto: { type: 'string', example: 'Carlos Herrera' },
          tipoDocumento: { type: 'string', example: 'cc' },
          numeroDocumento: { type: 'string', example: '1122334455' },
          correo: { type: 'string', example: 'carlos@empresa.com' },
          telefono: { type: 'string', example: '3009876543' },
          positionId: { type: 'string', example: 'pos_123' },
        },
      },
      UserInvitationRequest: {
        type: 'object',
        required: ['positionId', 'role'],
        properties: {
          positionId: { type: 'string', example: 'pos_123' },
          role: {
            type: 'string',
            enum: ['admin', 'operativo'],
            example: 'operativo',
          },
        },
      },
      CompleteInvitationRequest: {
        type: 'object',
        required: ['nombreCompleto', 'tipoDocumento', 'numeroDocumento', 'correo', 'telefono'],
        properties: {
          nombreCompleto: { type: 'string', example: 'Laura Perez' },
          tipoDocumento: { type: 'string', example: 'cc' },
          numeroDocumento: { type: 'string', example: '1020304050' },
          correo: { type: 'string', example: 'laura@empresa.com' },
          telefono: { type: 'string', example: '3001234567' },
        },
      },
      TurnRequest: {
        type: 'object',
        required: ['titulo', 'fecha', 'hora', 'assignedToUserId', 'locationId'],
        properties: {
          titulo: { type: 'string', example: 'Turno de triage' },
          descripcion: { type: 'string', example: 'Atencion inicial de pacientes' },
          fecha: { type: 'string', example: '2026-07-18' },
          hora: { type: 'string', example: '08:00' },
          horaFin: { type: 'string', example: '17:00' },
          assignedToUserId: { type: 'string', example: 'usr_123' },
          locationId: { type: 'string', example: 'loc_123' },
        },
      },
      AssignTurnRequest: {
        type: 'object',
        required: ['assignedToUserId'],
        properties: {
          assignedToUserId: { type: 'string', example: 'usr_123' },
        },
      },
      UpdateTurnStatusRequest: {
        type: 'object',
        required: ['estado'],
        properties: {
          estado: {
            type: 'string',
            enum: ['pendiente', 'asignado', 'en_proceso', 'finalizado'],
            example: 'en_proceso',
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          message: { type: 'string', example: 'Error de validacion' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Verificar estado del backend',
        responses: {
          '200': {
            description: 'Servicio activo',
          },
        },
      },
    },
    '/api/auth/register-company': {
      post: {
        tags: ['Auth'],
        summary: 'Registrar empresa con usuario administrador',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterCompanyRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Empresa creada correctamente' },
          '400': { description: 'Datos incompletos' },
          '409': { description: 'Empresa o admin duplicado' },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Autenticar usuario solo por numero de documento',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Login exitoso con token JWT' },
          '401': { description: 'Documento no autorizado' },
        },
      },
    },
    '/api/companies/me': {
      get: {
        tags: ['Companies'],
        summary: 'Obtener empresa del usuario autenticado',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Empresa obtenida correctamente' },
          '401': { description: 'No autenticado' },
        },
      },
    },
    '/api/companies/summary': {
      get: {
        tags: ['Companies'],
        summary: 'Resumen administrativo de la empresa',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Resumen obtenido correctamente' },
          '403': { description: 'Solo administradores' },
        },
      },
    },
    '/api/attendance/biometric-status': {
      get: {
        tags: ['Attendance'],
        summary: 'Consultar si el usuario autenticado ya tiene biometria registrada',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Estado biometrico obtenido' },
          '401': { description: 'No autenticado' },
          '404': { description: 'Usuario no encontrado' },
        },
      },
    },
    '/api/attendance/generate-registration-options': {
      post: {
        tags: ['Attendance'],
        summary: 'Generar challenge para registrar biometria en el dispositivo actual',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Opciones de registro generadas' },
          '401': { description: 'No autenticado' },
          '404': { description: 'Usuario no encontrado' },
        },
      },
    },
    '/api/attendance/verify-registration': {
      post: {
        tags: ['Attendance'],
        summary: 'Verificar y guardar una credencial biometrica WebAuthn',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AttendanceRegistrationVerificationRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Credencial biometrica registrada' },
          '400': { description: 'Registro biometrico invalido o incompleto' },
          '401': { description: 'No autenticado' },
          '404': { description: 'Usuario no encontrado' },
        },
      },
    },
    '/api/attendance/generate-authentication-options': {
      post: {
        tags: ['Attendance'],
        summary: 'Generar challenge para marcar entrada o salida de un turno',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AttendanceAuthenticationOptionsRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Opciones de autenticacion generadas' },
          '400': { description: 'Turno, accion o biometria no validos' },
          '401': { description: 'No autenticado' },
          '404': { description: 'Turno o usuario no encontrados' },
        },
      },
    },
    '/api/attendance/verify-authentication': {
      post: {
        tags: ['Attendance'],
        summary: 'Verificar biometria y geolocalizacion para marcar asistencia',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AttendanceAuthenticationVerificationRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Asistencia verificada y registrada' },
          '400': { description: 'Validacion biometrica o geolocalizacion incompleta' },
          '401': { description: 'No autenticado' },
          '403': { description: 'El usuario esta fuera del radio permitido' },
          '404': { description: 'Turno, ubicacion o usuario no encontrados' },
        },
      },
    },
    '/api/positions': {
      get: {
        tags: ['Positions'],
        summary: 'Listar puestos operativos de la empresa',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de puestos' },
        },
      },
      post: {
        tags: ['Positions'],
        summary: 'Crear puesto operativo',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PositionRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Puesto creado' },
          '403': { description: 'Solo administradores' },
        },
      },
    },
    '/api/locations': {
      get: {
        tags: ['Locations'],
        summary: 'Listar puntos de operacion de la empresa',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de ubicaciones' },
        },
      },
      post: {
        tags: ['Locations'],
        summary: 'Crear punto de operacion a partir de una URL de Google Maps',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LocationRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Ubicacion creada' },
          '400': { description: 'URL o datos invalidos' },
          '403': { description: 'Solo administradores' },
        },
      },
    },
    '/api/messages/whatsapp-link': {
      get: {
        tags: ['Messages'],
        summary: 'Generar un enlace de WhatsApp para abrir un chat con mensaje precargado',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'phone',
            required: true,
            schema: { type: 'string' },
            description: 'Numero en formato internacional, por ejemplo 573001234567.',
          },
          {
            in: 'query',
            name: 'text',
            required: false,
            schema: { type: 'string' },
            description: 'Texto que aparecera precargado en el chat.',
          },
        ],
        responses: {
          '200': { description: 'Enlace generado correctamente' },
          '400': { description: 'Telefono invalido o faltante' },
          '401': { description: 'No autenticado' },
        },
      },
      post: {
        tags: ['Messages'],
        summary: 'Generar un enlace de WhatsApp desde payload JSON',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/WhatsAppLinkRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Enlace generado correctamente' },
          '400': { description: 'Telefono invalido o faltante' },
          '401': { description: 'No autenticado' },
        },
      },
    },
    '/api/users': {
      get: {
        tags: ['Users'],
        summary: 'Listar usuarios de la empresa',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de usuarios' },
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Registrar usuario operativo vinculado a la empresa',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UserRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Usuario creado' },
          '409': { description: 'Usuario duplicado' },
        },
      },
    },
    '/api/users/invitations': {
      get: {
        tags: ['Users'],
        summary: 'Listar links de invitacion de integrantes',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de invitaciones' },
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Generar link de invitacion con cargo y rol predefinidos',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UserInvitationRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Invitacion creada' },
        },
      },
    },
    '/api/auth/member-invitations/{token}': {
      get: {
        tags: ['Auth'],
        summary: 'Consultar un link publico de invitacion',
        parameters: [
          {
            in: 'path',
            name: 'token',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Invitacion valida' },
          '404': { description: 'Invitacion no valida' },
        },
      },
    },
    '/api/auth/member-invitations/{token}/complete': {
      post: {
        tags: ['Auth'],
        summary: 'Completar el registro de un integrante desde su link',
        parameters: [
          {
            in: 'path',
            name: 'token',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CompleteInvitationRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Registro completado' },
          '404': { description: 'Invitacion no valida' },
          '409': { description: 'Usuario duplicado' },
        },
      },
    },
    '/api/turns': {
      get: {
        tags: ['Turns'],
        summary: 'Listar turnos de la empresa con filtros',
        security: [{ bearerAuth: [] }],
        parameters: [
          { in: 'query', name: 'fecha', schema: { type: 'string' } },
          { in: 'query', name: 'estado', schema: { type: 'string' } },
          { in: 'query', name: 'assignedToUserId', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Lista de turnos' },
        },
      },
      post: {
        tags: ['Turns'],
        summary: 'Crear turno',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TurnRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Turno creado' },
          '403': { description: 'Solo administradores' },
        },
      },
    },
    '/api/turns/{turnId}/assign': {
      patch: {
        tags: ['Turns'],
        summary: 'Asignar turno a usuario operativo',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'turnId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AssignTurnRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Turno asignado' },
          '404': { description: 'Turno o usuario no encontrado' },
        },
      },
    },
    '/api/turns/{turnId}/status': {
      patch: {
        tags: ['Turns'],
        summary: 'Actualizar estado de un turno',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'turnId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateTurnStatusRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Estado actualizado' },
          '403': { description: 'Sin permisos' },
        },
      },
    },
  },
} as const
