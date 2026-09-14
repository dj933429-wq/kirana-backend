import fs from 'fs';
import path from 'path';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config } from './index';
import { logger } from '../utils/logger';

// Sanitize connectionString so SSL query parameters (e.g. sslmode=require)
// do not cause pg's ConnectionParameters to overwrite our explicit SSL configuration
let connectionString = config.DATABASE_URL;
try {
  const parsedUrl = new URL(connectionString);
  const sslParams = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey'];
  let modified = false;
  for (const param of sslParams) {
    if (parsedUrl.searchParams.has(param)) {
      parsedUrl.searchParams.delete(param);
      modified = true;
    }
  }
  if (modified) {
    connectionString = parsedUrl.toString();
  }
} catch {
  // If not a standard URL, keep original connectionString
}

const poolConfig: pg.PoolConfig = {
  connectionString,
  max: config.DATABASE_POOL_SIZE,
};

const caCertPath = path.resolve(__dirname, '../../certs/supabase-root.crt');

if (config.DATABASE_SSL && !fs.existsSync(caCertPath)) {
  throw new Error(
    `FATAL: Supabase CA cert not found at ${caCertPath}. Refusing to start with insecure TLS fallback.`,
  );
}

const ca = config.DATABASE_SSL ? fs.readFileSync(caCertPath, 'utf8') : undefined;

if (config.DATABASE_SSL) {
  poolConfig.ssl = {
    rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED,
    ...(ca ? { ca } : {}),
  };
}

const pool = new pg.Pool(poolConfig);

logger.info(
  `DB SSL config: DATABASE_SSL=${config.DATABASE_SSL}, caCertPath=${caCertPath}, caLoaded=${!!ca}, caLength=${ca?.length ?? 0}, rejectUnauthorized=${config.DATABASE_SSL_REJECT_UNAUTHORIZED}`,
);

pool.on('error', (err) => {
  logger.error(`Unexpected database pool error: ${err.message}\nStack: ${err.stack}`);
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  log: ['query', 'info', 'warn', 'error'],
});

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
