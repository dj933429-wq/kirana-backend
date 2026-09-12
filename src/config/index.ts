import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env.test if in test environment and file exists; otherwise load standard .env
if (process.env.NODE_ENV === 'test' && fs.existsSync(path.resolve(process.cwd(), '.env.test'))) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: true });
} else {
  dotenv.config({ override: true });
}

const INSECURE_JWT_PLACEHOLDERS = [
  'your-super-secret-jwt-key',
  'secret',
  'password',
  'change-me',
  'default',
  '12345678',
  'jwt_secret',
  'testsecret',
];

const configSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection URL'),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(5),
    DATABASE_SSL: z.preprocess(
      (val) => (typeof val === 'string' ? val.toLowerCase() === 'true' || val === '1' : Boolean(val)),
      z.boolean(),
    ).default(false),
    DATABASE_SSL_REJECT_UNAUTHORIZED: z.preprocess(
      (val) => (typeof val === 'string' ? val.toLowerCase() === 'true' || val === '1' : val === undefined ? true : Boolean(val)),
      z.boolean(),
    ).default(true),
    JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters long'),
    JWT_EXPIRES_IN: z.string().default('1d'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CORS_ALLOWED_ORIGINS: z.string().default('*'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000), // 15 minutes
    RATE_LIMIT_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(10),
  })
  .refine(
    (data) => {
      // In production, enforce strong, non-placeholder JWT secret of at least 32 characters
      if (data.NODE_ENV === 'production') {
        if (data.JWT_SECRET.length < 32) return false;
        const secretLower = data.JWT_SECRET.toLowerCase();
        for (const placeholder of INSECURE_JWT_PLACEHOLDERS) {
          if (secretLower.includes(placeholder)) return false;
        }
      }
      return true;
    },
    {
      message:
        'In production, JWT_SECRET must be at least 32 characters long and must not contain common placeholder words.',
      path: ['JWT_SECRET'],
    },
  )
  .refine(
    (data) => {
      // In production, CORS_ALLOWED_ORIGINS must be explicitly configured and not allow wildcard '*'
      if (data.NODE_ENV === 'production') {
        return data.CORS_ALLOWED_ORIGINS !== '*' && data.CORS_ALLOWED_ORIGINS.trim().length > 0;
      }
      return true;
    },
    {
      message:
        'In production, CORS_ALLOWED_ORIGINS must be explicitly configured to specific allowed frontend domain(s) and cannot be "*".',
      path: ['CORS_ALLOWED_ORIGINS'],
    },
  )
  .refine(
    (data) => {
      // CRITICAL SAFETY GUARD: Prevent test runs from accidentally targeting a production database URL
      if (data.NODE_ENV === 'test') {
        const urlLower = data.DATABASE_URL.toLowerCase();
        const productionMarkers = ['production', 'prod_db', 'prod-db', 'live-db', 'live_db'];
        for (const marker of productionMarkers) {
          if (urlLower.includes(marker)) return false;
        }
      }
      return true;
    },
    {
      message:
        'CRITICAL SAFETY GUARD: Test execution rejected because DATABASE_URL contains production markers. Tests must use an isolated local test database.',
      path: ['DATABASE_URL'],
    },
  );

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof configSchema>;
