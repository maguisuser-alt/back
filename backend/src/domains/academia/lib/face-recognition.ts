/**
 * Face Recognition client — calls the FastAPI + DeepFace microservice
 * Endpoint: POST /api/verify-face
 */

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? ''

export interface FaceVerifyResult {
  success: boolean
  verified: boolean
  confidence: number
  distance: number
  threshold: number
  model: string
  message: string
}

/**
 * Register a user's face for future verification.
 * Sends the photo to the DeepFace service for storage.
 */
export async function registerFace(
  employeeId: string,
  imageBase64: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  if (!FACE_SERVICE_URL) return { success: true, message: 'Servicio facial no configurado' }

  try {
    const response = await fetch(`${FACE_SERVICE_URL}/api/register-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, imageBase64 }),
    })

    const data = await response.json() as { success?: boolean; message?: string; detail?: string }

    if (!response.ok) {
      return { success: false, error: data.detail ?? data.message ?? 'Error al registrar rostro' }
    }

    return { success: true, message: data.message }
  } catch (error) {
    console.warn('[face-recognition] Servicio no disponible para registro:', (error as Error).message)
    return { success: true, message: 'Servicio facial no disponible — registro omitido' }
  }
}

/**
 * Verify a face against the registered reference.
 * Returns the full verification result with confidence percentage.
 */
export async function verifyFace(
  employeeId: string,
  imageBase64: string,
): Promise<FaceVerifyResult> {
  if (!FACE_SERVICE_URL) {
    return {
      success: true,
      verified: true,
      confidence: 100,
      distance: 0,
      threshold: 0.4,
      model: 'bypass',
      message: 'Servicio facial no configurado — verificación omitida',
    }
  }

  try {
    const response = await fetch(`${FACE_SERVICE_URL}/api/verify-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, imageBase64 }),
    })

    const data = await response.json() as FaceVerifyResult & { detail?: string }

    if (!response.ok) {
      // 404 = no face registered → allow through (first time)
      if (response.status === 404) {
        return {
          success: true,
          verified: true,
          confidence: 0,
          distance: 1,
          threshold: 0.4,
          model: 'bypass',
          message: 'Sin rostro registrado — verificación omitida',
        }
      }
      return {
        success: false,
        verified: false,
        confidence: 0,
        distance: 1,
        threshold: 0.4,
        model: 'error',
        message: data.detail ?? 'Error en verificación facial',
      }
    }

    return data
  } catch (error) {
    console.warn('[face-recognition] Servicio no disponible:', (error as Error).message)
    return {
      success: true,
      verified: true,
      confidence: 0,
      distance: 0,
      threshold: 0.4,
      model: 'bypass',
      message: 'Servicio facial no disponible — verificación omitida',
    }
  }
}

/**
 * Check if the face service is available.
 */
export async function isFaceServiceAvailable(): Promise<boolean> {
  if (!FACE_SERVICE_URL) return false
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}
