import { Elysia } from 'elysia';
import { DomainError } from './errors';
import { approvalsModule } from './modules/approvals.module';
import { auditModule } from './modules/audit.module';
import { authModule } from './modules/auth.module';
import { budgetsModule } from './modules/budgets.module';
import { catalogsModule } from './modules/catalogs.module';
import { dashboardModule } from './modules/dashboard.module';
import { delegationsModule } from './modules/delegations.module';
import { expensesModule } from './modules/expenses.module';
import { filesModule } from './modules/files.module';
import { notificationsModule } from './modules/notifications.module';
import { rulesModule } from './modules/rules.module';
import { settlementsModule } from './modules/settlements.module';
import { treasuryModule } from './modules/treasury.module';
import { authPlugin } from './plugins/auth.plugin';

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (
    origin === configured ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return origin;
  }
  return null;
}

export const app = new Elysia({ prefix: '/api' })
  .onRequest(({ request, set }) => {
    const allowedOrigin = resolveAllowedOrigin(request.headers.get('origin'));
    if (allowedOrigin) {
      set.headers['Access-Control-Allow-Origin'] = allowedOrigin;
      set.headers['Access-Control-Allow-Credentials'] = 'true';
      set.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
      set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      set.headers['Vary'] = 'Origin';
    }
    if (request.method === 'OPTIONS') {
      set.status = 204;
      return '';
    }
  })
  .use(authPlugin)
  .onError(({ error, set, code }) => {
    if (error instanceof DomainError) {
      set.status = error.status;
      return {
        error: error.message,
        code: error.code,
        details: error.details ?? null,
      };
    }

    if (code === 'VALIDATION') {
      set.status = 400;
      return {
        error: 'Datos de entrada inválidos. Verifica los campos enviados.',
        code: 'VALIDATION_ERROR',
        details: error.message,
      };
    }

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return {
        error: 'Recurso API no encontrado.',
        code: 'NOT_FOUND',
      };
    }

    console.error('[Elysia Error]', error);
    set.status = 500;
    return {
      error: error instanceof Error ? error.message : 'Error interno del servidor',
      code: 'INTERNAL_ERROR',
    };
  })
  .get('/health', () => ({ ok: true, service: 'aproba-flow-api' }))
  .use(authModule)
  .use(catalogsModule)
  .use(budgetsModule)
  .use(expensesModule)
  .use(approvalsModule)
  .use(settlementsModule)
  .use(treasuryModule)
  .use(rulesModule)
  .use(delegationsModule)
  .use(dashboardModule)
  .use(auditModule)
  .use(notificationsModule)
  .use(filesModule);

export type App = typeof app;
