import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { AuthUser } from '../types.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'ommex-dev-secret'
const JWT_EXPIRES_IN = '8h'

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10)
}

export async function comparePassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash)
}

export function signToken(payload: AuthUser) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET) as AuthUser
}
