import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';
import './env';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://aprobaflow:aprobaflow_secret@127.0.0.1:5432/aprobaflow?schema=public';

const globalForPrisma = globalThis as unknown as {
  pgPool: Pool | undefined;
  prisma: PrismaClient | undefined;
};

const pool =
  globalForPrisma.pgPool ??
  new Pool({
    connectionString,
  });

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.pgPool = pool;
  globalForPrisma.prisma = prisma;
}
