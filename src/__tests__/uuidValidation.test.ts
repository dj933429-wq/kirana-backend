import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import jwt from 'jsonwebtoken';
import { config } from '../config';

describe('Security Hardening: UUID Route-Parameter Validation', () => {
  let user: { id: string; email: string };
  let validToken: string;
  let validCustomerId: string;
  let validTransactionId: string;

  beforeAll(async () => {
    // Clear and prepare test database
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();

    user = await prisma.user.create({
      data: {
        email: 'uuid.audit@example.com',
        passwordHash: 'hashedSecret123',
        businessName: 'UUID Validation Store',
      },
    });

    validToken = jwt.sign({ id: user.id, email: user.email }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        name: 'Valid Customer',
        phoneNumber: '9888888888',
        lendingRate: 12,
        depositRate: 6,
      },
    });
    validCustomerId = customer.id;

    const transaction = await prisma.transaction.create({
      data: {
        customerId: customer.id,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2026-01-01'),
        interestStartDate: new Date('2026-01-01'),
      },
    });
    validTransactionId = transaction.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();
    await disconnectDb();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Customer Route UUID Validation', () => {
    it('should accept valid UUID for GET /api/v1/customers/:id and execute query', async () => {
      const spy = jest.spyOn(prisma.customer, 'findFirst');
      const res = await request(app)
        .get(`/api/v1/customers/${validCustomerId}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.customer.id).toBe(validCustomerId);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should reject malformed UUID with 400 and prevent DB query on GET /api/v1/customers/:id', async () => {
      const spy = jest.spyOn(prisma.customer, 'findFirst');
      const res = await request(app)
        .get('/api/v1/customers/malformed-not-a-uuid')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors[0].field).toBe('id');
      expect(res.body.errors[0].message).toContain('Invalid UUID');
      expect(spy).not.toHaveBeenCalled();
    });

    it('should reject SQL injection payload in :id with 400 and no 500 or DB query', async () => {
      const spy = jest.spyOn(prisma.customer, 'findFirst');
      const res = await request(app)
        .get("/api/v1/customers/123'; DROP TABLE users; --")
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.status).not.toBe(500);
      expect(res.body.status).toBe('error');
      expect(spy).not.toHaveBeenCalled();
    });

    it('should reject malformed UUID with 400 on PATCH /api/v1/customers/:id', async () => {
      const spy = jest.spyOn(prisma.customer, 'update');
      const res = await request(app)
        .patch('/api/v1/customers/invalid-uuid-1234')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('id');
      expect(spy).not.toHaveBeenCalled();
    });

    it('should reject malformed UUID with 400 on DELETE /api/v1/customers/:id', async () => {
      const spy = jest.spyOn(prisma.customer, 'findFirst');
      const res = await request(app)
        .delete('/api/v1/customers/invalid-delete-id')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('id');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('2. Customer Sub-Resource UUID Validation (:customerId)', () => {
    it('should accept valid customerId on GET /api/v1/customers/:customerId/transactions', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${validCustomerId}/transactions`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data.transactions)).toBe(true);
    });

    it('should reject malformed customerId with 400 on GET /api/v1/customers/:customerId/transactions', async () => {
      const spy = jest.spyOn(prisma.transaction, 'findMany');
      const res = await request(app)
        .get('/api/v1/customers/not-a-valid-uuid/transactions')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('customerId');
      expect(spy).not.toHaveBeenCalled();
    });

    it('should accept valid customerId on GET /api/v1/customers/:customerId/ledger', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${validCustomerId}/ledger`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.summary).toBeDefined();
    });

    it('should reject malformed customerId with 400 on GET /api/v1/customers/:customerId/ledger without DB replay', async () => {
      const spy = jest.spyOn(prisma.customer, 'findFirst');
      const res = await request(app)
        .get('/api/v1/customers/bad-ledger-id/ledger')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('customerId');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('3. Transaction Route UUID Validation', () => {
    it('should accept valid transactionId on GET /api/v1/transactions/:id', async () => {
      const res = await request(app)
        .get(`/api/v1/transactions/${validTransactionId}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.transaction.id).toBe(validTransactionId);
    });

    it('should reject malformed ID with 400 and prevent DB query on GET /api/v1/transactions/:id', async () => {
      const spy = jest.spyOn(prisma.transaction, 'findFirst');
      const res = await request(app)
        .get('/api/v1/transactions/malformed-tx-id')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('id');
      expect(spy).not.toHaveBeenCalled();
    });

    it('should reject malformed ID with 400 on PATCH /api/v1/transactions/:id/void', async () => {
      const spy = jest.spyOn(prisma.transaction, 'update');
      const res = await request(app)
        .patch('/api/v1/transactions/invalid-void-id/void')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.errors[0].field).toBe('id');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
