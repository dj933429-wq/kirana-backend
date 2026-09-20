import request from 'supertest';
import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  loginRateLimiter,
  generalApiRateLimiter,
  createCustomRateLimiter,
} from '../middleware/rateLimiter';

describe('Production Hardening & Security Unit Tests', () => {
  describe('CORS Environment Security', () => {
    it('should allow requests from whitelisted production origins', async () => {
      const app = express();
      const allowedOrigins = ['https://app.kiranaledger.com', 'https://admin.kiranaledger.com'];
      app.use(
        cors({
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(new Error(`CORS Error: Origin ${origin} not allowed`));
            }
          },
        }),
      );
      app.get('/test', (_req, res) => res.json({ success: true }));

      const res = await request(app).get('/test').set('Origin', 'https://app.kiranaledger.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.kiranaledger.com');
    });

    it('should reject requests from unauthorized origins when strict CORS is configured', async () => {
      const app = express();
      const allowedOrigins = ['https://app.kiranaledger.com'];
      app.use(
        cors({
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(new Error(`CORS Error: Origin ${origin} not allowed`));
            }
          },
        }),
      );
      app.get('/test', (_req, res) => res.json({ success: true }));

      const res = await request(app).get('/test').set('Origin', 'https://malicious-site.com');

      expect(res.status).toBe(500); // Express CORS error
    });

    it('should allow server-to-server and health-check requests with no Origin header', async () => {
      const app = express();
      const allowedOrigins = ['https://app.kiranaledger.com'];
      app.use(
        cors({
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(new Error(`CORS Error: Origin ${origin} not allowed`));
            }
          },
        }),
      );
      app.get('/test', (_req, res) => res.json({ success: true }));

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    });
  });

  describe('Login Rate Limiter Middleware', () => {
    it('should allow requests within rate limit threshold', async () => {
      const app = express();
      app.post('/login-test', loginRateLimiter, (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success' });
      });

      const res = await request(app).post('/login-test');
      expect(res.status).toBe(200);
    });

    it('should reject requests exceeding login threshold with 429 and standard error structure', async () => {
      const app = express();
      const strictLoginLimiter = createCustomRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        message: 'Too many login attempts. Please try again later.',
      });

      app.post('/login-test', strictLoginLimiter, (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success' });
      });

      const res1 = await request(app).post('/login-test');
      expect(res1.status).toBe(200);

      const res2 = await request(app).post('/login-test');
      expect(res2.status).toBe(200);

      const res3 = await request(app).post('/login-test');
      expect(res3.status).toBe(429);
      expect(res3.body).toEqual({
        status: 'error',
        message: 'Too many login attempts. Please try again later.',
      });
      expect(res3.headers['ratelimit-remaining']).toBe('0');
    });
  });

  describe('General API Rate Limiter Middleware (/api/v1)', () => {
    it('should allow normal requests within general rate limit threshold', async () => {
      const app = express();
      app.use('/api/v1', generalApiRateLimiter);
      app.get('/api/v1/customers', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success', data: [] });
      });

      const res = await request(app).get('/api/v1/customers');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should reject requests exceeding threshold with HTTP 429 and project JSON error format', async () => {
      const app = express();
      const strictGeneralLimiter = createCustomRateLimiter({
        windowMs: 60 * 1000,
        limit: 3,
        message: 'Too many requests from this IP. Please try again later.',
      });

      app.use('/api/v1', strictGeneralLimiter);
      app.get('/api/v1/customers', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success' });
      });

      // 3 requests under limit
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api/v1/customers');
        expect(res.status).toBe(200);
      }

      // 4th request exceeds limit
      const blockedRes = await request(app).get('/api/v1/customers');
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body).toEqual({
        status: 'error',
        message: 'Too many requests from this IP. Please try again later.',
      });
      expect(blockedRes.headers['ratelimit-remaining']).toBe('0');
      expect(blockedRes.headers['ratelimit-limit']).toBe('3');
    });

    it('should keep /health accessible even when /api/v1 rate limit is exhausted', async () => {
      const app = express();
      const strictGeneralLimiter = createCustomRateLimiter({
        windowMs: 60 * 1000,
        limit: 1,
        message: 'Too many requests from this IP. Please try again later.',
      });

      // Health route mounted before rate limiter (matching src/app.ts)
      app.get('/health', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success', message: 'Server is healthy' });
      });

      // General rate limiter mounted on /api/v1
      app.use('/api/v1', strictGeneralLimiter);
      app.get('/api/v1/ledger', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'success' });
      });

      // Exhaust /api/v1 quota
      const apiRes1 = await request(app).get('/api/v1/ledger');
      expect(apiRes1.status).toBe(200);

      const apiRes2 = await request(app).get('/api/v1/ledger');
      expect(apiRes2.status).toBe(429);

      // /health remains accessible with 200 OK
      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('success');
      expect(healthRes.body.message).toBe('Server is healthy');
    });

    it('should enforce rate limiting across all sub-routers under /api/v1', async () => {
      const app = express();
      const strictGeneralLimiter = createCustomRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        message: 'Too many requests from this IP. Please try again later.',
      });

      app.use('/api/v1', strictGeneralLimiter);
      app.get('/api/v1/customers', (_req: Request, res: Response) => res.json({ ok: true }));
      app.get('/api/v1/transactions', (_req: Request, res: Response) => res.json({ ok: true }));

      // Request 1 to customers (count 1)
      const res1 = await request(app).get('/api/v1/customers');
      expect(res1.status).toBe(200);

      // Request 2 to transactions (count 2)
      const res2 = await request(app).get('/api/v1/transactions');
      expect(res2.status).toBe(200);

      // Request 3 to either route should be blocked under the shared /api/v1 scope
      const res3 = await request(app).get('/api/v1/customers');
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain('Too many requests from this IP');
    });
  });
});
