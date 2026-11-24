import { treaty } from '@elysiajs/eden';
import type { App } from '@aproba-flow/api/app';

function getBaseUrl() {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export const api = treaty<App>(getBaseUrl(), {
  fetch: {
    credentials: 'include',
  },
});

export function extractApiError(error: unknown, fallback = 'Ocurrió un error inesperado'): string {
  if (!error) return fallback;
  if (typeof error === 'object' && error !== null && 'value' in error) {
    const val = (error as { value?: unknown }).value;
    if (typeof val === 'object' && val !== null && 'error' in val) {
      return String((val as { error: unknown }).error);
    }
    if (typeof val === 'string') return val;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}
