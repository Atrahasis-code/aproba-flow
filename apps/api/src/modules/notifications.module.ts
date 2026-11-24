import { Elysia } from 'elysia';
import { prisma } from '../lib/prisma';
import { authPlugin, requireAuth } from '../plugins/auth.plugin';

export const notificationsModule = new Elysia({ prefix: '/notifications' })
  .use(authPlugin)
  .get('/', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    const [unreadCount, items] = await Promise.all([
      prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);
    return {
      unreadCount,
      items: items.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  })
  .patch('/:id/read', async ({ currentUser, params }) => {
    const user = requireAuth(currentUser);
    await prisma.notification.updateMany({
      where: { id: params.id, userId: user.id },
      data: { isRead: true },
    });
    return { ok: true };
  })
  .patch('/read-all', async ({ currentUser }) => {
    const user = requireAuth(currentUser);
    await prisma.notification.updateMany({
      where: { userId: user.id, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  });
