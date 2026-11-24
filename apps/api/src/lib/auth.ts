import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '../generated/prisma';

export const SESSION_COOKIE_NAME = 'aprobaflow_session';

export interface SessionPayload {
  userId: string;
  email: string;
  roles: UserRole[];
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET || 'aprobaflow-dev-super-secret-jwt-key-change-in-prod-2026';
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    email: payload.email,
    roles: payload.roles,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getJwtSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.sub || typeof payload.email !== 'string' || !Array.isArray(payload.roles)) {
      return null;
    }
    return {
      userId: payload.sub,
      email: payload.email,
      roles: payload.roles as UserRole[],
    };
  } catch {
    return null;
  }
}

export function hasRole(user: { roles: UserRole[] } | null | undefined, role: UserRole): boolean {
  return Boolean(user?.roles.includes(role));
}

export function hasAnyRole(user: { roles: UserRole[] } | null | undefined, roles: UserRole[]): boolean {
  if (!user) return false;
  return roles.some((role) => user.roles.includes(role));
}

export function isExecutiveViewer(user: { roles: UserRole[] } | null | undefined): boolean {
  return hasAnyRole(user, ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY']);
}

export function canSeeAllRequests(user: { roles: UserRole[] } | null | undefined): boolean {
  return hasAnyRole(user, ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY']);
}
