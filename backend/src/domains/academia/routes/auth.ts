import { Router } from 'express'
import { signToken } from '../lib/auth.js'
import { getDefaultModulesByType, getDefaultSettings, resolveAllowedModules, resolvePermissionLevels } from '../lib/access.js'
import {
  createCompany,
  createUser,
  findUserInvitationByToken,
  readDatabase,
  updateAcademicGroup,
  updateCompany,
  updateUser,
  updateUserInvitation,
} from '../lib/database.js'

export const authRouter = Router()

/**
 * POST /api/auth/embed
 * Ingreso embebido desde el producto de turnos: NO pide login.
 * Recibe el contexto de la sesión de turnos (companyId externo, nombre de la
 * institución, usuario, rol) y:
 *  - crea/reutiliza la institución en la DB de academia (keyed por externalId),
 *  - crea/reutiliza un usuario administrador puente para esa institución,
 *  - devuelve un token + usuario como el login normal.
 * Así, al entrar, Academia carga con el nombre de la compañía y sus opciones.
 */
authRouter.post('/embed', async (request, response) => {
  try {
    const { companyId, companyName, user, role } = request.body ?? {}
    if (!companyId) {
      response.status(400).json({ message: 'companyId es requerido para el acceso embebido.' })
      return
    }

    const externalId = String(companyId)
    const db = await readDatabase()

    // 1. Institución (keyed por externalId del producto de turnos).
    //    El índice único sobre externalId garantiza una sola institución por
    //    compañía externa; si dos requests concurrentes intentan crearla, la
    //    segunda recibe un error de duplicado y re-lee la existente.
    let company = db.companies.find((c) => c.externalId === externalId)
    const nombre = (companyName && String(companyName).trim()) || company?.nombre || 'Institución'
    if (!company) {
      try {
        company = await createCompany({
          externalId,
          nombre,
          nit: `EXT-${externalId}`,
          correo: `academia+${externalId}@klock.local`,
          tipo: 'academia',
          enabledModules: getDefaultModulesByType(),
          settings: getDefaultSettings(),
          activa: true,
          createdAt: new Date().toISOString(),
        })
      } catch (e) {
        // Carrera: otra request creó la institución con el mismo externalId.
        const retry = await readDatabase()
        company = retry.companies.find((c) => c.externalId === externalId)
        if (!company) throw e
      }
    } else if (companyName && company.nombre !== nombre) {
      company.nombre = nombre
      await updateCompany(company)
    }

    // 2. Usuario administrador puente (uno por institución)
    const bridgeDocumento = `embed-admin-${company.id}`
    let adminUser = db.users.find((u) => u.companyId === company!.id && u.numeroDocumento === bridgeDocumento)
    if (!adminUser) {
      adminUser = await createUser({
        companyId: company.id,
        nombreCompleto: user ? String(user) : 'Administrador',
        tipoDocumento: 'NIT',
        numeroDocumento: bridgeDocumento,
        correo: `admin+${company.id}@klock.local`,
        cargo: 'Administrador',
        role: 'admin',
        activa: true,
        createdAt: new Date().toISOString(),
      })
    } else if (user && adminUser.nombreCompleto !== String(user)) {
      adminUser.nombreCompleto = String(user)
      await updateUser(adminUser)
    }

    const freshDb = await readDatabase()
    const token = signToken({ userId: adminUser.id, companyId: company.id, role: 'admin' })
    response.json({
      token,
      user: {
        id: adminUser.id,
        companyId: company.id,
        nombreCompleto: adminUser.nombreCompleto,
        correo: adminUser.correo,
        cargo: adminUser.cargo,
        role: 'admin',
        allowedModules: resolveAllowedModules(freshDb, adminUser),
        permissionLevels: resolvePermissionLevels(freshDb, adminUser),
      },
      company: { id: company.id, nombre: company.nombre, externalId },
      // Ignora el rol de turnos para el acceso embebido inicial; siempre admin.
      embedRole: role ? String(role) : 'admin',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    console.error('[embed] Error:', message)
    response.status(500).json({ message: 'Error en el acceso embebido.', detail: message })
  }
})

/**
 * POST /api/auth/register-institution
 * Crea una institución educativa y su administrador principal.
 */
authRouter.post('/register-institution', async (request, response) => {
  try {
    const {
      institucion,
      nit,
      correoInstitucion,
      telefonoInstitucion,
      direccionInstitucion,
      ciudadInstitucion,
      adminNombreCompleto,
      adminCorreo,
      adminTelefono,
      adminTipoDocumento,
      adminNumeroDocumento,
    } = request.body ?? {}

    if (!institucion || !nit || !correoInstitucion || !adminNombreCompleto || !adminCorreo || !adminTipoDocumento || !adminNumeroDocumento) {
      response.status(400).json({ message: 'Faltan datos para registrar la institución.' })
      return
    }

    const db = await readDatabase()
    if (db.companies.find((c) => c.nit === nit || c.correo === correoInstitucion)) {
      response.status(409).json({ message: 'La institución ya existe.' })
      return
    }
    if (db.users.find((u) => u.correo === adminCorreo || u.numeroDocumento === adminNumeroDocumento)) {
      response.status(409).json({ message: 'El usuario administrador ya existe.' })
      return
    }

    const company = await createCompany({
      nombre: institucion,
      nit,
      correo: correoInstitucion,
      telefono: telefonoInstitucion,
      direccion: direccionInstitucion,
      ciudad: ciudadInstitucion,
      tipo: 'academia',
      enabledModules: getDefaultModulesByType(),
      settings: getDefaultSettings(),
      activa: true,
      createdAt: new Date().toISOString(),
    })

    const adminUser = await createUser({
      companyId: company.id,
      nombreCompleto: adminNombreCompleto,
      tipoDocumento: adminTipoDocumento,
      numeroDocumento: adminNumeroDocumento,
      correo: adminCorreo,
      telefono: adminTelefono,
      cargo: 'Administrador principal',
      role: 'admin',
      activa: true,
      createdAt: new Date().toISOString(),
    })

    response.status(201).json({
      message: 'Institución y administrador creados correctamente.',
      company,
      admin: { id: adminUser.id, nombreCompleto: adminUser.nombreCompleto, correo: adminUser.correo, role: adminUser.role },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    console.error('[register-institution] Error:', message)
    if (message.includes('Server selection timed out') || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      response.status(503).json({ message: 'No se puede conectar a la base de datos. Verifica MongoDB Atlas (Network Access 0.0.0.0/0).', detail: message })
      return
    }
    response.status(500).json({ message: 'Error interno al registrar la institución.', detail: message })
  }
})

/** POST /api/auth/login — ingreso por número de documento. */
authRouter.post('/login', async (request, response) => {
  try {
    const { numeroDocumento } = request.body ?? {}
    if (!numeroDocumento) {
      response.status(400).json({ message: 'El número de documento es requerido.' })
      return
    }

    const db = await readDatabase()
    const user = db.users.find((candidate) => candidate.numeroDocumento === numeroDocumento)
    if (!user || !user.activa) {
      response.status(401).json({ message: 'Documento no autorizado.' })
      return
    }

    const company = db.companies.find((c) => c.id === user.companyId)
    if (company && company.activa === false) {
      response.status(403).json({ message: 'La institución asociada a tu cuenta está inactiva.' })
      return
    }

    const token = signToken({ userId: user.id, companyId: user.companyId, role: user.role })

    response.json({
      token,
      user: {
        id: user.id,
        companyId: user.companyId,
        nombreCompleto: user.nombreCompleto,
        correo: user.correo,
        cargo: user.cargo,
        role: user.role,
        positionId: user.positionId,
        allowedModules: resolveAllowedModules(db, user),
        permissionLevels: resolvePermissionLevels(db, user),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    console.error('[login] Error:', message)
    if (message.includes('Server selection timed out') || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      response.status(503).json({ message: 'No se puede conectar a la base de datos.', detail: message })
      return
    }
    response.status(500).json({ message: 'Error interno al iniciar sesión.', detail: message })
  }
})

/** GET /api/auth/member-invitations/:token — detalle de invitación (alumno a grupo). */
authRouter.get('/member-invitations/:token', async (request, response) => {
  const invitation = await findUserInvitationByToken(request.params.token)
  if (!invitation || invitation.status !== 'pendiente') {
    response.status(404).json({ message: 'El enlace de registro no es válido o ya fue utilizado.' })
    return
  }
  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    response.status(410).json({ message: 'El enlace de registro ha expirado.' })
    return
  }

  const db = await readDatabase()
  const company = db.companies.find((item) => item.id === invitation.companyId)
  const academicGroup = invitation.academicGroupId
    ? db.academicGroups.find((g) => g.id === invitation.academicGroupId)
    : undefined

  response.json({
    token: invitation.token,
    company: company ? { id: company.id, nombre: company.nombre } : null,
    academicGroup: academicGroup
      ? { id: academicGroup.id, nombre: academicGroup.nombre }
      : (invitation.academicGroupId ? { id: invitation.academicGroupId, nombre: invitation.academicGroupNombre ?? 'Grupo' } : null),
    cargo: invitation.cargo,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  })
})

/** POST /api/auth/member-invitations/:token/complete — alumno se auto-registra. */
authRouter.post('/member-invitations/:token/complete', async (request, response) => {
  const invitation = await findUserInvitationByToken(request.params.token)
  if (!invitation || invitation.status !== 'pendiente') {
    response.status(404).json({ message: 'El enlace de registro no es válido o ya fue utilizado.' })
    return
  }
  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    response.status(410).json({ message: 'El enlace de registro ha expirado.' })
    return
  }

  const { nombreCompleto, tipoDocumento, numeroDocumento, correo, telefono } = request.body ?? {}
  if (!nombreCompleto || !tipoDocumento || !numeroDocumento || !correo) {
    response.status(400).json({ message: 'Faltan datos para completar el registro.' })
    return
  }

  const db = await readDatabase()
  if (db.users.find((u) => u.correo === correo || u.numeroDocumento === numeroDocumento)) {
    response.status(409).json({ message: 'El usuario ya existe.' })
    return
  }

  if (!invitation.academicGroupId) {
    response.status(400).json({ message: 'La invitación no corresponde a un grupo académico.' })
    return
  }

  const group = db.academicGroups.find((g) => g.id === invitation.academicGroupId && g.companyId === invitation.companyId)
  if (!group) {
    response.status(404).json({ message: 'El grupo de la invitación ya no existe.' })
    return
  }

  const student = await createUser({
    companyId: invitation.companyId,
    nombreCompleto,
    tipoDocumento,
    numeroDocumento,
    correo,
    telefono,
    cargo: 'Estudiante',
    role: 'estudiante',
    activa: true,
    estudiante: { fechaIngreso: new Date().toISOString() },
    createdAt: new Date().toISOString(),
  })

  if (!group.estudianteUserIds.includes(student.id)) {
    group.estudianteUserIds = [...group.estudianteUserIds, student.id]
    group.updatedAt = new Date().toISOString()
    await updateAcademicGroup(group)
  }

  invitation.invitedUserId = student.id
  await updateUserInvitation(invitation)

  response.status(201).json({
    message: `Registro completado. Quedaste asignado al grupo "${group.nombre}".`,
    user: { id: student.id, nombreCompleto: student.nombreCompleto, role: student.role, numeroDocumento: student.numeroDocumento },
    academicGroup: { id: group.id, nombre: group.nombre },
  })
})
