import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import jwt from 'jsonwebtoken';
import { config } from '../config';

describe('Audit: Authorization & User Isolation (Category D, E, F)', () => {
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;
  let customerAId: string;
  let customerBId: string;
  let transactionAId: string;

  beforeAll(async () => {
    // Clear test database
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();

    // Create User A and User B
    userA = await prisma.user.create({
      data: {
        email: 'user.a.audit@example.com',
        passwordHash: 'hashA123',
        businessName: 'Business A',
      },
    });

    userB = await prisma.user.create({
      data: {
        email: 'user.b.audit@example.com',
        passwordHash: 'hashB123',
        businessName: 'Business B',
      },
    });

    tokenA = jwt.sign({ id: userA.id, email: userA.email }, config.JWT_SECRET);
    tokenB = jwt.sign({ id: userB.id, email: userB.email }, config.JWT_SECRET);

    // Create Customer A for User A
    const custA = await prisma.customer.create({
      data: {
        userId: userA.id,
        name: 'Customer A of User A',
        phoneNumber: '9111111111',
        lendingRate: 0,
        depositRate: 0,
      },
    });
    customerAId = custA.id;

    // Create Customer B for User B
    const custB = await prisma.customer.create({
      data: {
        userId: userB.id,
        name: 'Customer B of User B',
        phoneNumber: '9222222222',
        lendingRate: 0,
        depositRate: 0,
      },
    });
    customerBId = custB.id;

    // Create a Transaction for Customer A
    const txA = await prisma.transaction.create({
      data: {
        customerId: customerAId,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2026-01-01T00:00:00.000Z'),
        interestStartDate: new Date('2026-01-01T00:00:00.000Z'),
        remarks: 'User A purchase',
      },
    });
    transactionAId = txA.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();
    await disconnectDb();
  });

  describe('D1: Cross-User Customer Access Prevention (IDOR)', () => {
    it('User A should be able to read their own customer', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerAId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.customer.id).toBe(customerAId);
    });

    it('User B must NOT be able to read User A customer (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerAId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('error');
    });

    it('User B must NOT be able to update User A customer (returns 404)', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/${customerAId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Hacked Name' });

      expect(res.status).toBe(404);
    });

    it('User B must NOT be able to delete/archive User A customer (returns 404)', async () => {
      const res = await request(app)
        .delete(`/api/v1/customers/${customerAId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });

    it('User A must NOT be able to access User B customer (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerBId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('D2: Cross-User Transaction Access Prevention (IDOR)', () => {
    it('User A can view transaction on Customer A', async () => {
      const res = await request(app)
        .get(`/api/v1/transactions/${transactionAId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.transaction.id).toBe(transactionAId);
    });

    it('User B must NOT be able to view User A transaction by ID (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/transactions/${transactionAId}`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });

    it('User B must NOT be able to list User A customer transactions (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerAId}/transactions`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });

    it('User B must NOT be able to void User A transaction (returns 404)', async () => {
      const res = await request(app)
        .patch(`/api/v1/transactions/${transactionAId}/void`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });
  });

  describe('D3: Cross-User Ledger Access Prevention (IDOR)', () => {
    it('User A can view Customer A ledger', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerAId}/ledger`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.customer.id).toBe(customerAId);
    });

    it('User B must NOT be able to view User A customer ledger (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerAId}/ledger`)
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });
  });

  describe('D4: Non-existent and Malformed UUID Boundaries', () => {
    it('Random non-existent UUID should return 404', async () => {
      const randomUuid = 'a0000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get(`/api/v1/customers/${randomUuid}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });

    it('Random non-existent transaction UUID should return 404', async () => {
      const randomUuid = 'b0000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get(`/api/v1/transactions/${randomUuid}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });
  });
});
