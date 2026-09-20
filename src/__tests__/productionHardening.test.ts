import request from 'supertest';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { loginRateLimiter } from '../middleware/rateLimiter';

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
  });
});
