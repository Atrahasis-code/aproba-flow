import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

const repoRoot = path.resolve(import.meta.dirname, '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'bun prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
