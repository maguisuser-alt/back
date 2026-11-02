import { Router } from 'express'

/**
 * Metadatos de este microfrontend para el Host (/root-panel).
 * Expone el ESQUEMA de opciones de configuración reales de academia, para que
 * el portal las descubra dinámicamente y las muestre por compañía.
 */
export const mfeRouter = Router()

mfeRouter.get('/config-schema', (_req, res) => {
  res.json({
    name: 'Academia',
    version: 1,
    fields: [
      { key: 'attendanceMode', label: 'Modo de asistencia', type: 'select', default: 'qr',
        options: [
          { label: 'Código QR', value: 'qr' },
          { label: 'Reconocimiento facial', value: 'face' },
          { label: 'Manual', value: 'manual' },
        ] },
      { key: 'allowVirtual', label: 'Permitir clases virtuales', type: 'boolean', default: true },
      { key: 'gracePeriodMin', label: 'Tolerancia de ingreso (min)', type: 'number', default: 10 },
      { key: 'notifyGuardians', label: 'Notificar a acudientes', type: 'boolean', default: false },
      { key: 'requireFaceForVirtual', label: 'Exigir rostro en clases virtuales', type: 'boolean', default: false },
    ],
  })
})
