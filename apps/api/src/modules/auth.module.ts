import { Elysia, t } from 'elysia';
import { SESSION_COOKIE_NAME, signSessionToken, verifyPassword } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth } from '../plugins/auth.plugin';

const isDemoMode = () => process.env.NEXT_PUBLIC_DEMO_MODE !== 'false';

export const authModule = new Elysia({ prefix: '/auth' })
  .use(authPlugin)
  .post(
    '/login',
    async ({ body, cookie }) => {
      const user = await prisma.user.findUnique({
        where: { email: body.email.trim().toLowerCase() },
        include: {
          branch: { select: { name: true, code: true } },
          department: { select: { name: true } },
        },
      });

      if (!user || !user.isActive) {
        throw new DomainError('Credenciales inválidas o usuario inactivo.', 401, 'INVALID_CREDENTIALS');
      }

      const valid = await verifyPassword(body.password, user.passwordHash);
      if (!valid) {
        throw new DomainError('Credenciales inválidas.', 401, 'INVALID_CREDENTIALS');
      }

      const token = await signSessionToken({
        userId: user.id,
        email: user.email,
        roles: user.roles,
      });

      cookie[SESSION_COOKIE_NAME].set({
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });

      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          employeeCode: user.employeeCode,
          jobTitle: user.jobTitle,
          branchId: user.branchId,
          branchName: user.branch.name,
          branchCode: user.branch.code,
          departmentId: user.departmentId,
          departmentName: user.department.name,
          managerId: user.managerId,
          roles: user.roles,
          bankName: user.bankName,
          bankAccountNumber: user.bankAccountNumber,
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ minLength: 3 }),
        password: t.String({ minLength: 1 }),
      }),
    }
  )
  .post('/logout', ({ cookie }) => {
    cookie[SESSION_COOKIE_NAME].set({
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    cookie[SESSION_COOKIE_NAME].remove();
    return { ok: true };
  })
  .get('/me', ({ currentUser }) => {
    const user = requireAuth(currentUser);
    return { user };
  })
  .get('/demo-users', async () => {
    if (!isDemoMode()) {
      return { enabled: false, users: [] };
    }
    const users = await prisma.user.findMany({
      where: { isActive: true },
      include: {
        branch: { select: { code: true, name: true } },
        department: { select: { code: true, name: true } },
      },
      orderBy: [{ employeeCode: 'asc' }],
    });
    return {
      enabled: true,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        employeeCode: u.employeeCode,
        jobTitle: u.jobTitle,
        roles: u.roles,
        branchName: u.branch.name,
        branchCode: u.branch.code,
        departmentName: u.department.name,
      })),
    };
  })
  .post(
    '/demo-switch',
    async ({ body, cookie }) => {
      if (!isDemoMode()) {
        throw new DomainError('El conmutador rápido demo está deshabilitado.', 403, 'DEMO_DISABLED');
      }

      const user = await prisma.user.findUnique({
        where: { id: body.userId },
        include: {
          branch: { select: { name: true, code: true } },
          department: { select: { name: true } },
        },
      });
      if (!user || !user.isActive) {
        throw new DomainError('Usuario demo no encontrado.', 404);
      }

      const token = await signSessionToken({
        userId: user.id,
        email: user.email,
        roles: user.roles,
      });

      cookie[SESSION_COOKIE_NAME].set({
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });

      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          employeeCode: user.employeeCode,
          jobTitle: user.jobTitle,
          branchId: user.branchId,
          branchName: user.branch.name,
          branchCode: user.branch.code,
          departmentId: user.departmentId,
          departmentName: user.department.name,
          managerId: user.managerId,
          roles: user.roles,
          bankName: user.bankName,
          bankAccountNumber: user.bankAccountNumber,
        },
      };
    },
    {
      body: t.Object({
        userId: t.String({ minLength: 1 }),
      }),
    }
  );
