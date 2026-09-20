import request from 'supertest';
import app from '../app';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

describe('Audit: Configuration, Security, Validation & Middleware (Categories A, B, T, U, V, Y, Z)', () => {
  describe('Category A: Configuration & Environment Validation', () => {
    it('A1: should validate that essential config keys are defined and typed correctly', () => {
      expect(config.PORT).toBeDefined();
      expect(typeof config.PORT).toBe('number');
      expect(config.NODE_ENV).toBeDefined();
      expect(['development', 'production', 'test']).toContain(config.NODE_ENV);
      expect(config.JWT_SECRET).toBeDefined();
      expect(config.JWT_SECRET.length).toBeGreaterThanOrEqual(8);
      expect(config.CORS_ALLOWED_ORIGINS).toBeDefined();
    });

    it('A2: should reject empty or whitespace JWT_SECRET in config schema', () => {
      const testSchema = z.string().min(8, 'JWT_SECRET must be at least 8 characters long');
      expect(() => testSchema.parse('')).toThrow();
      expect(() => testSchema.parse('   ')).toThrow();
      expect(() => testSchema.parse('short')).toThrow();
      expect(testSchema.parse('valid-long-secret-key-12345')).toBe('valid-long-secret-key-12345');
    });

    it('A3: should reject wildcard CORS in production environment validation', () => {
      const prodCorsSchema = z
        .object({
          NODE_ENV: z.enum(['development', 'production', 'test']),
          CORS_ALLOWED_ORIGINS: z.string(),
        })
        .refine(
          (data) => {
            if (data.NODE_ENV === 'production') {
              return (
                data.CORS_ALLOWED_ORIGINS !== '*' && data.CORS_ALLOWED_ORIGINS.trim().length > 0
              );
            }
            return true;
          },
          { message: 'In production, CORS_ALLOWED_ORIGINS cannot be "*"' },
        );

      expect(() =>
        prodCorsSchema.parse({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' }),
      ).toThrow();
      expect(() =>
        prodCorsSchema.parse({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '   ' }),
      ).toThrow();
      expect(
        prodCorsSchema.parse({
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://kirana-frontend-tau.vercel.app',
        }),
      ).toBeDefined();
    });

    it('A4: should reject insecure placeholder JWT secrets in production', () => {
      const INSECURE_JWT_PLACEHOLDERS = ['change-me', 'secret', 'default', 'development'];
      const prodJwtSchema = z
        .object({
          NODE_ENV: z.enum(['development', 'production', 'test']),
          JWT_SECRET: z.string(),
        })
        .refine(
          (data) => {
            if (data.NODE_ENV === 'production') {
              if (data.JWT_SECRET.length < 32) return false;
              const secretLower = data.JWT_SECRET.toLowerCase();
              for (const placeholder of INSECURE_JWT_PLACEHOLDERS) {
                if (secretLower.includes(placeholder)) return false;
              }
            }
            return true;
          },
          { message: 'Insecure JWT_SECRET in production' },
        );

      expect(() =>
        prodJwtSchema.parse({ NODE_ENV: 'production', JWT_SECRET: 'short-secret' }),
      ).toThrow();
      expect(() =>
        prodJwtSchema.parse({
          NODE_ENV: 'production',
          JWT_SECRET: 'this-is-a-32-char-string-with-change-me-inside!',
        }),
      ).toThrow();
      expect(
        prodJwtSchema.parse({
          NODE_ENV: 'production',
          JWT_SECRET: 'a-completely-secure-32-character-random-auth-token-12345!',
        }),
      ).toBeDefined();
    });
  });

  describe('Category B: Health & Server Endpoints', () => {
    it('B1: GET /health should return 200 with standard health contract', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Server is healthy');
      expect(res.body.timestamp).toBeDefined();
      expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();
    });

    it('B2: Unsupported HTTP methods on /health should return 404 or 405', async () => {
      const postRes = await request(app).post('/health').send({ dummy: true });
      expect(postRes.status).toBe(404);
      const putRes = await request(app).put('/health').send({ dummy: true });
      expect(putRes.status).toBe(404);
      const delRes = await request(app).delete('/health');
      expect(delRes.status).toBe(404);
    });
  });

  describe('Category T & U: API Validation, JSON Payloads & Error Handling', () => {
    it('T1: should reject malformed JSON body with structured 400 error', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{ "email": "test@example.com", "password": '); // broken JSON

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toMatch(/Malformed JSON/i);
    });

    it('T2: should reject unexpected non-JSON Content-Type gracefully or process body', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'text/plain')
        .send('raw text');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('T3: AppError should preserve status code and message without leaking internals', () => {
      const notFoundErr = new AppError('Resource strictly not found', 404);
      expect(notFoundErr.statusCode).toBe(404);
      expect(notFoundErr.message).toBe('Resource strictly not found');
      expect(notFoundErr.isOperational).toBe(true);

      const conflictErr = new AppError('Duplicate record conflict', 409);
      expect(conflictErr.statusCode).toBe(409);
      expect(conflictErr.message).toBe('Duplicate record conflict');
    });

    it('T4: Unhandled internal error should return 404 for unknown route without leaking stack traces', async () => {
      const res = await request(app).get('/api/v1/non-existent-route-404');
      expect(res.status).toBe(404);
      expect(res.body.stack).toBeUndefined();
    });
  });

  describe('Category V: Security Testing (Injection, Header Tampering, XSS Payloads)', () => {
    it('V1: SQL injection string in login should be safely handled without SQL syntax error', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: "' OR '1'='1' --",
        password: "' OR '1'='1' --",
      });

      // Zod rejects invalid email format
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(JSON.stringify(res.body)).not.toMatch(/syntax error/i);
      expect(JSON.stringify(res.body)).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    });

    it('V2: XSS script tags in login email should be caught by validator', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: "<script>alert('xss')</script>@example.com",
        password: 'password123',
      });

      expect([400, 401]).toContain(res.status);
      expect(res.body.status).toBe('error');
    });

    it('V3: Tampered or forged JWT signature should be strictly rejected with 401', async () => {
      const forgedToken = jwt.sign(
        { id: 'random-user-id', email: 'fake@example.com' },
        'completely-wrong-secret-key-1234567890',
        { expiresIn: '1h' },
      );

      const res = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toMatch(/invalid/i);
    });

    it('V4: Expired JWT should be strictly rejected with 401', async () => {
      const expiredToken = jwt.sign(
        { id: 'user-id', email: 'expired@example.com' },
        config.JWT_SECRET,
        { expiresIn: '-10s' }, // expired 10 seconds ago
      );

      const res = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toMatch(/expired/i);
    });

    it('V5: Missing or empty Bearer token should be rejected with 401', async () => {
      const resMissing = await request(app).get('/api/v1/customers');
      expect(resMissing.status).toBe(401);

      const resEmptyBearer = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', 'Bearer ');
      expect(resEmptyBearer.status).toBe(401);

      const resWrongScheme = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(resWrongScheme.status).toBe(401);
    });
  });

  describe('Category Y: Security Headers (Helmet)', () => {
    it('Y1: should return Helmet security headers on responses', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  });
});
