import crypto from 'crypto';
import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

describe('Auth Module Integration Tests', () => {
  let merchant: { id: string; email: string };
  const rawPassword = 'password123';

  beforeAll(async () => {
    // Clean database
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();

    const passwordHash = await bcrypt.hash(rawPassword, 10);
    merchant = await prisma.user.create({
      data: {
        email: 'merchant@test.com',
        passwordHash,
        businessName: 'Merchant Test Stores',
      },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();
    await disconnectDb();
  });

  describe('POST /api/v1/auth/login', () => {
    it('should successfully login with correct credentials', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'merchant@test.com',
        password: rawPassword,
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.user.email).toBe(merchant.email);
      expect(response.body.data.user.id).toBe(merchant.id);
      expect(response.body.data.user.businessName).toBe('Merchant Test Stores');
    });

    it('should fail to login with wrong password', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'merchant@test.com',
        password: 'wrongpassword',
      });

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid email or password');
    });

    it('should fail to login with non-existent email', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'nonexistent@test.com',
        password: rawPassword,
      });

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid email or password');
    });

    it('should fail to login with invalid input types (validation schema)', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'invalid-email-format',
        password: '',
      });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toBeDefined();
    });
  });

  describe('Auth Middleware Route Protection', () => {
    it('should reject access with 401 when Authorization header is missing', async () => {
      const response = await request(app).get('/api/v1/customers');
      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Token missing or malformed');
    });

    it('should reject access with 401 with malformed token (no Bearer prefix)', async () => {
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', 'InvalidTokenBody');
      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Token missing or malformed');
    });

    it('should reject access with 401 with invalid token', async () => {
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', 'Bearer invalid-token');
      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject access with 401 with expired token', async () => {
      const expiredToken = jwt.sign({ id: merchant.id, email: merchant.email }, config.JWT_SECRET, {
        expiresIn: '-10s',
      });
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject access with 401 when user no longer exists in database', async () => {
      const tempToken = jwt.sign(
        { id: 'non-existent-uuid-1234', email: 'deleted@test.com' },
        config.JWT_SECRET,
        { expiresIn: '1d' },
      );
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${tempToken}`);
      expect(response.status).toBe(401);
      expect(response.body.message).toContain('User no longer exists');
    });
  });

  describe('JWT Algorithm Restriction & Enforcement', () => {
    it('should accept a legitimate token signed with HS256', async () => {
      const validToken = jwt.sign({ id: merchant.id, email: merchant.email }, config.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '1h',
      });
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${validToken}`);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
    });

    it('should reject a token signed with an unsupported asymmetric algorithm (RS256)', async () => {
      // Dynamically generate an in-memory ephemeral RSA keypair (never stored in repo)
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const rs256Token = jwt.sign({ id: merchant.id, email: merchant.email }, privateKey, {
        algorithm: 'RS256',
        expiresIn: '1h',
      });

      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${rs256Token}`);

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject an unsigned token using the "none" algorithm', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          id: merchant.id,
          email: merchant.email,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${noneToken}`);

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject a token signed with the wrong secret', async () => {
      const wrongSecretToken = jwt.sign(
        { id: merchant.id, email: merchant.email },
        'different-unauthorized-secret-key-32chars',
        { algorithm: 'HS256', expiresIn: '1h' },
      );

      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${wrongSecretToken}`);

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject a completely malformed token string', async () => {
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', 'Bearer not.a.valid.jwt.token');

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid or expired token');
    });

    it('should reject an expired HS256 token', async () => {
      const expiredToken = jwt.sign({ id: merchant.id, email: merchant.email }, config.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '-1h',
      });

      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid or expired token');
    });
  });
});
