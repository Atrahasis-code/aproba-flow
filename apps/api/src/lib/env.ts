import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// apps/api/src/lib -> ../.. (api) -> .. (apps) -> .. (repo root)
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

export function getUploadDir(): string {
  const configured = process.env.UPLOAD_DIR || './storage/uploads';
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(REPO_ROOT, configured);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}
