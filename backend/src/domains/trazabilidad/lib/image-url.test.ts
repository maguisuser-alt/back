import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDirectImageUrl, isSendableUrl } from './image-url.ts'

test('toDirectImageUrl: convierte enlace /file/d/<ID>/view de Drive a descarga directa', () => {
  const out = toDirectImageUrl('https://drive.google.com/file/d/ABC123_xyz/view?usp=sharing')
  assert.equal(out, 'https://drive.google.com/uc?export=download&id=ABC123_xyz')
})

test('toDirectImageUrl: convierte enlace con ?id= de Drive', () => {
  const out = toDirectImageUrl('https://drive.google.com/uc?id=ZZZ999')
  assert.equal(out, 'https://drive.google.com/uc?export=download&id=ZZZ999')
})

test('toDirectImageUrl: deja intactas URLs de R2/GitHub', () => {
  const r2 = 'https://bucket.r2.cloudflarestorage.com/op/foto.jpg'
  const gh = 'https://raw.githubusercontent.com/user/repo/main/foto.jpg'
  assert.equal(toDirectImageUrl(r2), r2)
  assert.equal(toDirectImageUrl(gh), gh)
})

test('toDirectImageUrl: no rompe con cadena vacía', () => {
  assert.equal(toDirectImageUrl(''), '')
})

test('isSendableUrl: válida solo http(s) y no pending-verification', () => {
  assert.equal(isSendableUrl('https://x/f.jpg'), true)
  assert.equal(isSendableUrl('http://x/f.jpg'), true)
  assert.equal(isSendableUrl('pending-verification'), false)
  assert.equal(isSendableUrl(''), false)
  assert.equal(isSendableUrl(undefined), false)
  assert.equal(isSendableUrl('data:image/png;base64,xxx'), false)
})
