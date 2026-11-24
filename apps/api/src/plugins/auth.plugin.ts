import { Elysia } from 'elysia';
import type { UserRole } from '../generated/prisma';
import { hasAnyRole, SESSION_COOKIE_NAME, verifySessionToken } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  departmentId: string;
  departmentName: string;
  managerId: string | null;
  roles: UserRole[];
  bankName: string | null;
  bankAccountNumber: string | null;
}

function parseCookieHeader(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === cookieName) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export const authPlugin = new Elysia({ name: 'auth-plugin' }).derive(
  { as: 'global' },
  async ({ request, cookie }) => {
    const cookieVal =
      (cookie?.[SESSION_COOKIE_NAME]?.value as string | undefined) ??
      parseCookieHeader(request.headers.get('cookie'), SESSION_COOKIE_NAME);

    const forwarded = request.headers.get('x-forwarded-for');
    const clientIp =
      forwarded?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '127.0.0.1';
    const userAgent = request.headers.get('user-agent') || 'AprobaFlow-Client';

    let currentUser: AuthUser | null = null;

    if (cookieVal) {
      const payload = await verifySessionToken(cookieVal);
      if (payload) {
        const dbUser = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: {
            branch: { select: { name: true, code: true } },
            department: { select: { name: true } },
          },
        });

        if (dbUser && dbUser.isActive) {
          currentUser = {
            id: dbUser.id,
            email: dbUser.email,
            fullName: dbUser.fullName,
            employeeCode: dbUser.employeeCode,
            jobTitle: dbUser.jobTitle,
            branchId: dbUser.branchId,
            branchName: dbUser.branch.name,
            branchCode: dbUser.branch.code,
            departmentId: dbUser.departmentId,
            departmentName: dbUser.department.name,
            managerId: dbUser.managerId,
            roles: dbUser.roles,
            bankName: dbUser.bankName,
            bankAccountNumber: dbUser.bankAccountNumber,
          };
        }
      }
    }

    return {
      currentUser,
      clientIp,
      userAgent,
    };
  }
);

export function requireAuth(currentUser: AuthUser | null): AuthUser {
  if (!currentUser) {
    throw new DomainError('Sesión no autenticada. Inicia sesión para continuar.', 401, 'UNAUTHORIZED');
  }
  return currentUser;
}

export function requireRoles(currentUser: AuthUser | null, allowedRoles: UserRole[]): AuthUser {
  const user = requireAuth(currentUser);
  if (!hasAnyRole(user, allowedRoles)) {
    throw new DomainError(
      'No tienes permisos suficientes para realizar esta acción.',
      403,
      'FORBIDDEN'
    );
  }
  return user;
}
