/**
 * Errores tipados del backend unificado.
 * Cada ruta lanza un AppError y el errorHandler central lo traduce a una
 * respuesta JSON homogénea { message, code }.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code?: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message, 400, code)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'No autorizado', code = 'UNAUTHORIZED') {
    super(message, 401, code)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Acceso denegado', code = 'FORBIDDEN') {
    super(message, 403, code)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado', code = 'NOT_FOUND') {
    super(message, 404, code)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, 409, code)
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, code = 'UPSTREAM_ERROR') {
    super(message, 502, code)
  }
}

/** Detecta fallos de disponibilidad de MongoDB Atlas (deben ser 503, no 500). */
export function isMongoUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message
  return [
    'ECONNREFUSED',
    'Server selection timed out',
    'connect ETIMEDOUT',
    'MongoServerSelectionError',
    'MongoNetworkError',
    'MongoDB no inicializado',
  ].some((needle) => m.includes(needle))
}
