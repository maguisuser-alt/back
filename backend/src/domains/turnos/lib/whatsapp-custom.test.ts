import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCustom, MAX_CUSTOM_TEMPLATES, MAX_TEMPLATE_OPTIONS } from './whatsapp-custom.js'

test('sanitizeCustom: no-array devuelve lista vacía', () => {
  assert.deepEqual(sanitizeCustom(undefined), [])
  assert.deepEqual(sanitizeCustom({}), [])
  assert.deepEqual(sanitizeCustom('x'), [])
})

test('sanitizeCustom: conserva una plantilla válida', () => {
  const [t] = sanitizeCustom([{ id: 'tpl_1', name: ' Cambio de sede ', enabled: true, template: 'Hola {nombre}', options: [{ id: 'ok', label: 'Entendido' }] }])
  assert.deepEqual(t, { id: 'tpl_1', name: 'Cambio de sede', enabled: true, template: 'Hola {nombre}', options: [{ id: 'ok', label: 'Entendido' }] })
})

test('sanitizeCustom: ids inválidos o repetidos se regeneran', () => {
  const list = sanitizeCustom([{ id: 'a b$', name: 'x' }, { id: 'dup', name: 'y' }, { id: 'dup', name: 'z' }])
  assert.equal(list.length, 3)
  assert.match(list[0].id, /^tpl_/)
  assert.equal(list[1].id, 'dup')
  assert.notEqual(list[2].id, 'dup')
})

test('sanitizeCustom: nombre vacío recibe uno por defecto y enabled por defecto true', () => {
  const [t] = sanitizeCustom([{ id: 't', name: '   ', template: 'x' }])
  assert.equal(t.name, 'Plantilla 1')
  assert.equal(t.enabled, true)
})

test('sanitizeCustom: aplica límites de cantidad y tamaño', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: 'n', template: 'x'.repeat(3000) }))
  const list = sanitizeCustom(many)
  assert.equal(list.length, MAX_CUSTOM_TEMPLATES)
  assert.equal(list[0].template.length, 2000)
  const opts = Array.from({ length: 15 }, (_, i) => ({ id: `o${i}`, label: `L${i}` }))
  assert.equal(sanitizeCustom([{ id: 't', options: opts }])[0].options.length, MAX_TEMPLATE_OPTIONS)
})

test('sanitizeCustom: descarta opciones sin texto', () => {
  const [t] = sanitizeCustom([{ id: 't', options: [{ id: 'a', label: '  ' }, { label: 'Sí' }, null] }])
  assert.deepEqual(t.options, [{ id: 'opt_2', label: 'Sí' }])
})
