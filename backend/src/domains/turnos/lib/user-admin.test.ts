import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canManageUsers, checkStatusChange, publicUser } from './user-admin.js'

const admin = { id: 'a1', role: 'admin' as const, activa: true }
const admin2 = { id: 'a2', role: 'admin' as const, activa: true }
const sup = { id: 's1', role: 'supervisor' as const, activa: true }
const op = { id: 'o1', role: 'operativo' as const, activa: true }

test('quién puede administrar usuarios', () => {
  assert.equal(canManageUsers({ role: 'admin' }, []), true)
  assert.equal(canManageUsers({ role: 'supervisor' }, ['dashboard']), false)
  assert.equal(canManageUsers({ role: 'operativo' }, ['editar-empleados']), true)
  assert.equal(canManageUsers({ role: 'supervisor' }, ['eliminar-empleados']), true)
})

test('reglas de activar/desactivar', () => {
  assert.equal(checkStatusChange({ actor: admin, target: op, activa: false, activeAdmins: 1 }).ok, true)
  // nadie se desactiva a sí mismo
  assert.equal(checkStatusChange({ actor: admin, target: admin, activa: false, activeAdmins: 2 }).ok, false)
  // un no-admin con permisos no toca a un admin
  assert.equal(checkStatusChange({ actor: sup, target: admin, activa: false, activeAdmins: 2 }).ok, false)
  // un admin puede desactivar a otro admin si queda alguno activo
  assert.equal(checkStatusChange({ actor: admin, target: admin2, activa: false, activeAdmins: 2 }).ok, true)
  // nunca el último admin activo (ni el root)
  const r = checkStatusChange({ actor: 'root', target: admin2, activa: false, activeAdmins: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.status, 409)
  // reactivar siempre se permite
  assert.equal(checkStatusChange({ actor: 'root', target: { ...admin2, activa: false }, activa: true, activeAdmins: 0 }).ok, true)
})

test('publicUser quita datos sensibles', () => {
  const u = publicUser({
    id: 'u', companyId: 'c', nombreCompleto: 'X', tipoDocumento: 'CC', numeroDocumento: '1', correo: 'x@x', cargo: 'Op',
    role: 'operativo', activa: undefined as unknown as boolean, createdAt: '',
    passwordHash: 'secret', faceDescriptor: [1, 2, 3], biometric: { credentials: [] } as never,
    faceProfile: { faceDescriptors: [{ descriptor: [1], registeredAt: '' }], estado: 'activo' } as never,
  })
  assert.equal('passwordHash' in u, false)
  assert.equal('faceDescriptor' in u, false)
  assert.equal('biometric' in u, false)
  assert.equal('faceProfile' in u, false)
  assert.equal(u.tienePassword, true)
  assert.equal(u.faceRegistered, true)
  assert.equal(u.faceEstado, 'activo')
  assert.equal(u.activa, true) // ausente cuenta como activo
})
