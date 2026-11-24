import nodemailer from 'nodemailer';
import type { NotificationType, Prisma, PrismaClient } from '../generated/prisma';
import { prisma as defaultPrisma } from '../lib/prisma';

export interface NotificationPayload {
  userId: string;
  userEmail?: string;
  userName?: string;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl?: string;
  sendEmail?: boolean;
}

function getTransporter() {
  const host = process.env.SMTP_HOST || '127.0.0.1';
  const port = Number(process.env.SMTP_PORT || '1025');
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
  });
}

function buildEmailHtml(params: {
  recipientName: string;
  title: string;
  message: string;
  linkUrl?: string;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const fullLink = params.linkUrl ? `${appUrl}${params.linkUrl}` : appUrl;

  return `
  <!DOCTYPE html>
  <html lang="es">
    <body style="font-family: Inter, Arial, sans-serif; background: #f8fafc; padding: 24px; color: #0f172a;">
      <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f172a; color: #ffffff; padding: 16px 24px;">
          <strong style="font-size: 16px;">AprobaFlow</strong>
          <span style="font-size: 12px; color: #94a3b8; margin-left: 8px;">Control de Gastos y Aprobaciones</span>
        </div>
        <div style="padding: 24px;">
          <p style="margin: 0 0 12px; font-size: 14px; color: #475569;">Hola, <strong>${params.recipientName}</strong>:</p>
          <h2 style="margin: 0 0 12px; font-size: 18px; color: #0f172a;">${params.title}</h2>
          <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #334155;">${params.message}</p>
          <a href="${fullLink}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Abrir en AprobaFlow
          </a>
        </div>
        <div style="padding: 14px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
          Notificación automática del Sistema de Control de Gastos y Aprobaciones.
        </div>
      </div>
    </body>
  </html>
  `;
}

export async function createNotification(
  payload: NotificationPayload,
  db: PrismaClient | Prisma.TransactionClient = defaultPrisma
) {
  const created = await db.notification.create({
    data: {
      userId: payload.userId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      linkUrl: payload.linkUrl ?? null,
      isRead: false,
      emailSent: false,
    },
  });

  if (payload.sendEmail !== false) {
    // Dispatch SMTP outside blocking transaction callers if desired; safe fire-and-update
    const dispatch = async () => {
      try {
        let email = payload.userEmail;
        let name = payload.userName;
        if (!email || !name) {
          const user = await defaultPrisma.user.findUnique({
            where: { id: payload.userId },
            select: { email: true, fullName: true },
          });
          email = email ?? user?.email;
          name = name ?? user?.fullName;
        }
        if (!email) return;

        const transporter = getTransporter();
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'AprobaFlow <no-reply@aprobaflow.local>',
          to: email,
          subject: `[AprobaFlow] ${payload.title}`,
          text: `${payload.title}\n\n${payload.message}\n`,
          html: buildEmailHtml({
            recipientName: name || 'Colaborador',
            title: payload.title,
            message: payload.message,
            linkUrl: payload.linkUrl,
          }),
        });

        await defaultPrisma.notification.update({
          where: { id: created.id },
          data: { emailSent: true },
        });
      } catch {
        // Resiliente a fallos SMTP para no abortar transacciones de negocio
      }
    };

    // Wait briefly only if explicitly invoked on defaultPrisma, otherwise schedule microtask
    if (db === defaultPrisma) {
      await dispatch();
    } else {
      setTimeout(() => {
        void dispatch();
      }, 50);
    }
  }

  return created;
}

export async function notifyRoleUsers(
  roles: Array<'FINANCE' | 'DIRECTION' | 'TREASURY' | 'ADMIN'>,
  payload: Omit<NotificationPayload, 'userId' | 'userEmail' | 'userName'>,
  db: PrismaClient | Prisma.TransactionClient = defaultPrisma
) {
  const users = await db.user.findMany({
    where: {
      isActive: true,
      roles: { hasSome: roles },
    },
    select: { id: true, email: true, fullName: true },
  });

  for (const user of users) {
    await createNotification(
      {
        ...payload,
        userId: user.id,
        userEmail: user.email,
        userName: user.fullName,
      },
      db
    );
  }
}
