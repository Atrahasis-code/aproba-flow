import { Elysia } from 'elysia';
import type { Prisma } from '../generated/prisma';
import { prisma } from '../lib/prisma';
import { authPlugin, requireRoles } from '../plugins/auth.plugin';
import { generateAuditCsv } from '../services/export.service';

export const auditModule = new Elysia({ prefix: '/audit' })
  .use(authPlugin)
  .get('/', async ({ currentUser, query }) => {
    requireRoles(currentUser, ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY']);

    const page = Math.max(1, Number(query.page || '1'));
    const limit = Math.min(100, Math.max(10, Number(query.limit || '40')));

    const where: Prisma.AuditLogWhereInput = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    if (query.action) where.action = { contains: query.action, mode: 'insensitive' };
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { summary: { contains: s, mode: 'insensitive' } },
        { actorName: { contains: s, mode: 'insensitive' } },
        { onBehalfOfName: { contains: s, mode: 'insensitive' } },
        { action: { contains: s, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.timestamp = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      total,
      page,
      limit,
      items: items.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    };
  })
  .get('/export', async ({ currentUser, query }) => {
    requireRoles(currentUser, ['FINANCE', 'DIRECTION', 'ADMIN', 'TREASURY']);

    const where: Prisma.AuditLogWhereInput = {};
    if (query.from || query.to) {
      where.timestamp = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 2000,
    });

    const csv = generateAuditCsv(logs);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="auditoria-aprobaflow-${stamp}.csv"`,
      },
    });
  });
