'use client';

import * as React from 'react';
import { Camera, FileText, Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export interface UploadedFileMeta {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

interface ReceiptUploaderProps {
  value?: UploadedFileMeta | null;
  purpose?: 'RECEIPT' | 'RETURN_DEPOSIT' | 'PAYMENT_PROOF';
  onChange: (file: UploadedFileMeta | null) => void;
  onPreview?: (file: UploadedFileMeta) => void;
  compact?: boolean;
}

export function ReceiptUploader({
  value,
  purpose = 'RECEIPT',
  onChange,
  onPreview,
  compact = false,
}: ReceiptUploaderProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('purpose', purpose);

      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || 'Error al subir el comprobante');
        return;
      }
      onChange({
        id: json.id,
        originalName: json.originalName,
        mimeType: json.mimeType,
        sizeBytes: json.sizeBytes,
      });
      toast.success(`Comprobante "${json.originalName}" cargado`);
    } catch {
      toast.error('No se pudo subir el comprobante');
    } finally {
      setUploading(false);
    }
  };

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => onPreview?.(value)}
          className="flex items-center gap-2 text-emerald-900 font-medium truncate hover:underline cursor-pointer"
        >
          <FileText className="h-4 w-4 text-emerald-600 shrink-0" />
          <span className="truncate">{value.originalName}</span>
          <span className="text-[11px] text-emerald-700 shrink-0">
            ({Math.max(1, Math.round(value.sizeBytes / 1024))} KB)
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded p-1 text-slate-400 hover:bg-white hover:text-rose-600 cursor-pointer"
          title="Quitar comprobante"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void uploadFile(file);
      }}
      className={cn(
        'rounded-lg border border-dashed transition-colors flex flex-wrap items-center justify-between gap-2',
        compact ? 'px-3 py-2' : 'p-3',
        dragOver ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-slate-50/70'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadFile(f);
          e.target.value = '';
        }}
      />

      <div className="flex items-center gap-2 text-xs text-slate-600">
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
        ) : (
          <Upload className="h-4 w-4 text-slate-400" />
        )}
        <span>{uploading ? 'Subiendo comprobante...' : 'PDF, JPG, PNG o WEBP (máx. 10 MB)'}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
        >
          Seleccionar archivo
        </button>
        <button
          type="button"
          disabled={uploading}
          onClick={() => cameraRef.current?.click()}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 sm:hidden cursor-pointer"
        >
          <Camera className="h-3.5 w-3.5" />
          Foto
        </button>
      </div>
    </div>
  );
}
