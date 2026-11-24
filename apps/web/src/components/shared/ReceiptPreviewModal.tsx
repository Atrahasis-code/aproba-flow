'use client';

import { Download, ExternalLink, FileText } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { UploadedFileMeta } from '@/components/shared/ReceiptUploader';

export function ReceiptPreviewModal({
  file,
  onClose,
}: {
  file: UploadedFileMeta | null;
  onClose: () => void;
}) {
  if (!file) return null;
  const fileUrl = `/api/files/${file.id}`;
  const isPdf = file.mimeType === 'application/pdf';

  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-brand-600" />
            <span className="truncate">{file.originalName}</span>
          </DialogTitle>
          <DialogDescription>
            Vista previa segura del comprobante ({file.mimeType} •{' '}
            {Math.max(1, Math.round(file.sizeBytes / 1024))} KB)
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-slate-200 bg-slate-100 overflow-hidden min-h-[360px] flex items-center justify-center">
          {isPdf ? (
            <iframe
              src={fileUrl}
              title={file.originalName}
              className="w-full h-[520px] bg-white"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl}
              alt={file.originalName}
              className="max-h-[520px] w-auto object-contain"
            />
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Abrir en pestaña
          </a>
          <a
            href={fileUrl}
            download={file.originalName}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700"
          >
            <Download className="h-3.5 w-3.5" />
            Descargar comprobante
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
