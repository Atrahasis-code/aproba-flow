import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Elysia, t } from 'elysia';
import type { FilePurpose } from '../generated/prisma';
import { canSeeAllRequests } from '../lib/auth';
import { getUploadDir } from '../lib/env';
import { prisma } from '../lib/prisma';
import { DomainError } from '../errors';
import { authPlugin, requireAuth } from '../plugins/auth.plugin';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export const filesModule = new Elysia({ prefix: '/files' })
  .use(authPlugin)
  .post(
    '/upload',
    async ({ currentUser, body }) => {
      const user = requireAuth(currentUser);
      const file = body.file;
      if (!file) {
        throw new DomainError('No se recibió ningún archivo.', 400);
      }

      if (file.size === 0) {
        throw new DomainError('El archivo está vacío.', 400);
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new DomainError('El archivo supera el límite máximo permitido de 10 MB.', 400);
      }

      const origName = (file.name || 'comprobante').trim();
      const extFromName = path.extname(origName).toLowerCase();
      let mimeType = (file.type || '').toLowerCase();

      if (!ALLOWED_MIME_EXT[mimeType]) {
        if (EXT_TO_MIME[extFromName]) {
          mimeType = EXT_TO_MIME[extFromName];
        } else {
          throw new DomainError(
            'Formato de comprobante inválido. Solo se admiten PDF, JPG, PNG o WEBP.',
            400,
            'INVALID_FILE_TYPE'
          );
        }
      }

      const ext = ALLOWED_MIME_EXT[mimeType] || extFromName || '.bin';
      const storedName = `${crypto.randomUUID()}${ext}`;
      const uploadDir = getUploadDir();
      const targetPath = path.join(uploadDir, storedName);

      const bytes = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(targetPath, bytes);

      const purpose = (
        body.purpose === 'RETURN_DEPOSIT' || body.purpose === 'PAYMENT_PROOF'
          ? body.purpose
          : 'RECEIPT'
      ) as FilePurpose;

      const record = await prisma.storedFile.create({
        data: {
          originalName: origName,
          storedName,
          mimeType,
          sizeBytes: bytes.length,
          storagePath: storedName,
          purpose,
          uploadedById: user.id,
        },
      });

      return {
        id: record.id,
        originalName: record.originalName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        url: `/api/files/${record.id}`,
      };
    },
    {
      body: t.Object({
        file: t.File(),
        purpose: t.Optional(t.String()),
      }),
    }
  )
  .get('/:id', async ({ currentUser, params }) => {
    const user = requireAuth(currentUser);
    const stored = await prisma.storedFile.findUnique({
      where: { id: params.id },
      include: {
        expenseItems: {
          include: {
            expenseRequest: {
              include: {
                project: { select: { managerId: true } },
                approvalSteps: { select: { assignedApproverId: true, delegatedToUserId: true } },
              },
            },
          },
        },
        returnDeposits: {
          include: {
            project: { select: { managerId: true } },
            approvalSteps: { select: { assignedApproverId: true, delegatedToUserId: true } },
          },
        },
      },
    });

    if (!stored) {
      throw new DomainError('Comprobante no encontrado.', 404);
    }

    const canGlobal = canSeeAllRequests(user) || stored.uploadedById === user.id;
    let canViaRequest = false;

    const linkedRequests = [
      ...stored.expenseItems.map((i) => i.expenseRequest),
      ...stored.returnDeposits,
    ];
    for (const req of linkedRequests) {
      if (
        req.requesterId === user.id ||
        req.project?.managerId === user.id ||
        req.approvalSteps.some(
          (s) => s.assignedApproverId === user.id || s.delegatedToUserId === user.id
        )
      ) {
        canViaRequest = true;
        break;
      }
    }

    if (!canGlobal && !canViaRequest) {
      throw new DomainError('No tienes permiso para acceder a este comprobante.', 403);
    }

    const filePath = path.join(getUploadDir(), path.basename(stored.storagePath));
    if (!fs.existsSync(filePath)) {
      throw new DomainError('Archivo físico no encontrado en almacenamiento.', 404);
    }

    const bytes = fs.readFileSync(filePath);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': stored.mimeType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(stored.originalName)}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  });
