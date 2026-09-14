import fs from 'fs';
import path from 'path';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from './index';
import { logger } from '../utils/logger';

const poolConfig: pg.PoolConfig = {
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
};

if (config.DATABASE_SSL) {
  const caCertPath = path.resolve(process.cwd(), 'certs/supabase-root.crt');
  const ca = fs.existsSync(caCertPath) ? fs.readFileSync(caCertPath, 'utf8') : undefined;

  poolConfig.ssl = {
    rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED,
    ...(ca ? { ca } : {}),
  };
}

const pool = new pg.Pool(poolConfig);

pool.on('error', (err) => {
  logger.error(`Unexpected database pool error: ${err.message}\nStack: ${err.stack}`);
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

export const disconnectDb = async (): Promise<void> => {
  try {
    await prisma.$disconnect();
    await pool.end();
    logger.info('Database pool closed successfully.');
  } catch (err) {
    logger.error(
      `Error closing database pool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
