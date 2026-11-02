import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldForwardToTurnos } from './turnos-link.ts'

test('Property 4: sin TURNOS_API_URL nunca reenvía', () => {
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: '', companyId: 'c1', whatsappUnified: true }), false)
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: null, companyId: 'c1', whatsappUnified: true }), false)
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: undefined, companyId: 'c1', whatsappUnified: true }), false)
})

test('Property 4: whatsappUnified=false (o ausente) nunca reenvía', () => {
  const url = 'https://turnos.example.com'
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: url, companyId: 'c1', whatsappUnified: false }), false)
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: url, companyId: 'c1', whatsappUnified: undefined }), false)
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: url, companyId: 'c1', whatsappUnified: 'true' }), false) // solo boolean true
})

test('sin companyId nunca reenvía', () => {
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: 'https://t', companyId: '', whatsappUnified: true }), false)
})

test('reenvía SOLO con url + companyId + whatsappUnified===true', () => {
  assert.equal(shouldForwardToTurnos({ turnosApiUrl: 'https://t', companyId: 'c1', whatsappUnified: true }), true)
})
