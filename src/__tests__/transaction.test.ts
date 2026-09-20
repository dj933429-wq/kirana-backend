import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import {
  CompoundingFrequency,
  InterestType,
  Transaction,
  TransactionType,
} from '../generated/prisma/client';
import jwt from 'jsonwebtoken';
import { config } from '../config';

describe('Transaction Module Integration Tests', () => {
  let merchantA: { id: string; email: string };
  let merchantB: { id: string; email: string };
  let customerActiveA: { id: string };
  let customerActiveB: { id: string };
  let customerArchivedA: { id: string };
  let transactionAId: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    // Clean database to ensure deterministic tests
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();

    // Create test merchants
    merchantA = await prisma.user.create({
      data: {
        email: 'merchant.a.tx@test.com',
        passwordHash: 'hashed123',
        businessName: 'Merchant A Stores',
      },
    });

    merchantB = await prisma.user.create({
      data: {
        email: 'merchant.b.tx@test.com',
        passwordHash: 'hashed456',
        businessName: 'Merchant B Stores',
      },
    });

    // Create customers for Merchant A
    customerActiveA = await prisma.customer.create({
      data: {
        userId: merchantA.id,
        name: 'Active Customer A',
        phoneNumber: '9000000001',
        lendingRate: 24,
        depositRate: 12,
        compoundingFrequency: CompoundingFrequency.MONTHLY,
        isActive: true,
      },
    });

    customerArchivedA = await prisma.customer.create({
      data: {
        userId: merchantA.id,
        name: 'Archived Customer A',
        phoneNumber: '9000000002',
        lendingRate: 24,
        depositRate: 12,
        compoundingFrequency: CompoundingFrequency.MONTHLY,
        isActive: false, // Inactive
      },
    });

    // Create customer for Merchant B
    customerActiveB = await prisma.customer.create({
      data: {
        userId: merchantB.id,
        name: 'Active Customer B',
        phoneNumber: '9000000003',
        lendingRate: 24,
        depositRate: 12,
        compoundingFrequency: CompoundingFrequency.MONTHLY,
        isActive: true,
      },
    });

    tokenA = jwt.sign({ id: merchantA.id, email: merchantA.email }, config.JWT_SECRET);
    tokenB = jwt.sign({ id: merchantB.id, email: merchantB.email }, config.JWT_SECRET);
  });

  afterAll(async () => {
    // Final cleanup
    await prisma.transaction.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.user.deleteMany();
    await disconnectDb();
  });

  describe('POST /api/v1/transactions - Create Transaction', () => {
    it('should create a valid DEBIT transaction and return 201', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 1500.75,
          date: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
          interestStartDate: new Date().toISOString(),
          remarks: '  Cash loan for farming  ',
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('success');
      expect(response.body.data.transaction).toBeDefined();
      expect(response.body.data.transaction.customerId).toBe(customerActiveA.id);
      expect(response.body.data.transaction.type).toBe(TransactionType.DEBIT);
      expect(Number(response.body.data.transaction.amount)).toBe(1500.75);
      expect(response.body.data.transaction.remarks).toBe('Cash loan for farming'); // Trimmed
      expect(response.body.data.transaction.isVoided).toBe(false);

      transactionAId = response.body.data.transaction.id;
    });

    it('should create a valid CREDIT transaction and return 201', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.CREDIT,
          amount: 500,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
          remarks: 'Received via UPI',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.transaction.type).toBe(TransactionType.CREDIT);
      expect(Number(response.body.data.transaction.amount)).toBe(500);
    });

    it('should reject transaction with zero amount with 400', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 0,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe('error');
    });

    it('should reject transaction with negative amount with 400', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: -100,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
        });

      expect(response.status).toBe(400);
    });

    it('should reject transaction with decimal precision > 2 digits with 400', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 15.123, // 3 decimal places
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
      expect(JSON.stringify(response.body.errors)).toContain('decimal');
    });

    it('should reject transaction date in the future with 400', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // 1 day future
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 100,
          date: futureDate,
          interestStartDate: futureDate,
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
      expect(JSON.stringify(response.body.errors)).toContain('future');
    });

    it('should reject interest start date in the future with 400', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 100,
          date: new Date().toISOString(),
          interestStartDate: futureDate,
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
      expect(JSON.stringify(response.body.errors)).toContain('future');
    });

    it('should reject interest start date before transaction date with 400', async () => {
      const txDate = new Date(Date.now() - 3600000); // 1 hour ago
      const interestDate = new Date(Date.now() - 7200000); // 2 hours ago (before txDate)
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 100,
          date: txDate.toISOString(),
          interestStartDate: interestDate.toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
      expect(JSON.stringify(response.body.errors)).toContain('before the transaction date');
    });

    it('should reject transaction under customer owned by another merchant with 404', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`) // Merchant A trying to post under Merchant B's customer
        .send({
          customerId: customerActiveB.id,
          type: TransactionType.DEBIT,
          amount: 100,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
        });

      expect(response.status).toBe(404);
    });

    it('should reject transaction under archived customer with 404', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerArchivedA.id, // Inactive customer
          type: TransactionType.DEBIT,
          amount: 100,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
        });

      expect(response.status).toBe(404);
    });

    it('should create DEBIT with explicit interestType and interestRate', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 2000,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
          interestType: 'SIMPLE',
          interestRate: 18,
          dueDate: new Date(Date.now() + 86400000).toISOString(),
        });

      expect(response.status).toBe(201);
      expect(response.body.data.transaction.interestType).toBe('SIMPLE');
      expect(Number(response.body.data.transaction.interestRate)).toBe(18);
    });

    it('should create DEBIT with COMPOUND and CUSTOM frequency with customCompoundDays', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 3000,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
          interestType: 'COMPOUND',
          compoundingFrequency: 'CUSTOM',
          customCompoundDays: 30,
        });

      expect(response.status).toBe(201);
      expect(response.body.data.transaction.compoundingFrequency).toBe('CUSTOM');
      expect(response.body.data.transaction.customCompoundDays).toBe(30);
    });

    it('should reject DEBIT with CUSTOM compounding if customCompoundDays is missing', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 3000,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
          interestType: 'COMPOUND',
          compoundingFrequency: 'CUSTOM',
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
    });

    it('should reject CREDIT if interest configuration is supplied (Rule 2)', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: TransactionType.CREDIT,
          amount: 500,
          date: new Date().toISOString(),
          interestStartDate: new Date().toISOString(),
          interestType: 'SIMPLE', // Forbidden on CREDIT
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
      expect(JSON.stringify(response.body.errors)).toContain('not allowed for CREDIT');
    });
  });

  describe('GET /api/v1/transactions/:id - Get Single Transaction', () => {
    it('should successfully retrieve a transaction by ID', async () => {
      const response = await request(app)
        .get(`/api/v1/transactions/${transactionAId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.transaction.id).toBe(transactionAId);
      // Verify relation is not nested in return payload
      expect(response.body.data.transaction.customer).toBeUndefined();
    });

    it('should return 404 when trying to retrieve a transaction belonging to another merchant', async () => {
      const response = await request(app)
        .get(`/api/v1/transactions/${transactionAId}`)
        .set('Authorization', `Bearer ${tokenB}`); // Merchant B requesting Merchant A's transaction

      expect(response.status).toBe(404);
    });

    it('should return 404 for a non-existent transaction UUID', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const response = await request(app)
        .get(`/api/v1/transactions/${nonExistentId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/customers/:customerId/transactions - List Customer Transactions', () => {
    let oldTx: Transaction, newTx: Transaction, middleTx: Transaction;

    beforeAll(async () => {
      // Clear for pagination testing
      await prisma.transaction.deleteMany();

      // Seed 3 transactions with different dates
      oldTx = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 100,
          date: new Date('2026-08-01T00:00:00.000Z'),
          interestStartDate: new Date('2026-08-01T00:00:00.000Z'),
        },
      });

      middleTx = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.CREDIT,
          amount: 200,
          date: new Date('2026-08-03T00:00:00.000Z'),
          interestStartDate: new Date('2026-08-03T00:00:00.000Z'),
          isVoided: true, // Seeding one voided
        },
      });

      newTx = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 300,
          date: new Date('2026-08-05T00:00:00.000Z'),
          interestStartDate: new Date('2026-08-05T00:00:00.000Z'),
        },
      });
    });

    it('should return non-voided transactions by default (isVoided=false fallback)', async () => {
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.transactions).toHaveLength(2); // Only non-voided
      const ids = response.body.data.transactions.map((t: Transaction) => t.id);
      expect(ids).toContain(oldTx.id);
      expect(ids).toContain(newTx.id);
      expect(ids).not.toContain(middleTx.id);
    });

    it('should sort transactions in descending order by date by default', async () => {
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.body.data.transactions[0].id).toBe(newTx.id); // newer first
      expect(response.body.data.transactions[1].id).toBe(oldTx.id); // older second
    });

    it('should fetch with page and limit parameters', async () => {
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ page: 2, limit: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data.transactions).toHaveLength(1);
      expect(response.body.data.transactions[0].id).toBe(oldTx.id);
      expect(response.body.data.pagination).toEqual({
        total: 2,
        page: 2,
        limit: 1,
        totalPages: 2,
        hasNext: false,
        hasPrevious: true,
      });
    });

    it('should support sorting parameters (asc/desc) and whitelist sorting keys', async () => {
      // Ascending sort by amount
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ sort: 'amount', order: 'asc' });

      expect(response.status).toBe(200);
      expect(Number(response.body.data.transactions[0].amount)).toBe(100);
      expect(Number(response.body.data.transactions[1].amount)).toBe(300);

      // Rejects invalid sort keys
      const invalidResponse = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ sort: 'remarks' }); // not in whitelist

      expect(invalidResponse.status).toBe(400);
    });

    it('should filter by type (DEBIT / CREDIT)', async () => {
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ type: TransactionType.DEBIT });

      expect(response.status).toBe(200);
      expect(response.body.data.transactions).toHaveLength(2);
      response.body.data.transactions.forEach((t: Transaction) => {
        expect(t.type).toBe(TransactionType.DEBIT);
      });
    });

    it('should filter by isVoided explicitly (true / false / all)', async () => {
      // isVoided = true
      let res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ isVoided: 'true' });
      expect(res.body.data.transactions).toHaveLength(1);
      expect(res.body.data.transactions[0].id).toBe(middleTx.id);

      // isVoided = all
      res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ isVoided: 'all' });
      expect(res.body.data.transactions).toHaveLength(3);
    });

    it('should filter by date ranges (startDate, endDate)', async () => {
      // startDate only
      let res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ isVoided: 'all', startDate: '2026-08-02T00:00:00.000Z' });
      expect(res.body.data.transactions).toHaveLength(2); // middleTx (Aug 3) and newTx (Aug 5)

      // endDate only
      res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ isVoided: 'all', endDate: '2026-08-04T00:00:00.000Z' });
      expect(res.body.data.transactions).toHaveLength(2); // oldTx (Aug 1) and middleTx (Aug 3)

      // both startDate and endDate range
      res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({
          isVoided: 'all',
          startDate: '2026-08-02T00:00:00.000Z',
          endDate: '2026-08-04T00:00:00.000Z',
        });
      expect(res.body.data.transactions).toHaveLength(1);
      expect(res.body.data.transactions[0].id).toBe(middleTx.id);

      // Invalid range startDate > endDate
      res = await request(app)
        .get(`/api/v1/customers/${customerActiveA.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`)
        .query({ startDate: '2026-08-05T00:00:00.000Z', endDate: '2026-08-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
    });

    it('should return 404 when listing transactions of a customer owned by another merchant', async () => {
      const response = await request(app)
        .get(`/api/v1/customers/${customerActiveB.id}/transactions`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/transactions/:id/void - Void Transaction', () => {
    let transToVoid: Transaction;

    beforeEach(async () => {
      await prisma.transaction.deleteMany();
      transToVoid = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 500,
          date: new Date(),
          interestStartDate: new Date(),
          isVoided: false,
        },
      });
    });

    it('should successfully void a transaction', async () => {
      const response = await request(app)
        .patch(`/api/v1/transactions/${transToVoid.id}/void`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.message).toContain('voided');
      expect(response.body.data.transaction.isVoided).toBe(true);

      // Verify DB change
      const dbTx = await prisma.transaction.findUnique({ where: { id: transToVoid.id } });
      expect(dbTx?.isVoided).toBe(true);
    });

    it('should reject voiding an already voided transaction with 400 (idempotency)', async () => {
      // First void
      await request(app)
        .patch(`/api/v1/transactions/${transToVoid.id}/void`)
        .set('Authorization', `Bearer ${tokenA}`);

      // Second void attempt
      const response = await request(app)
        .patch(`/api/v1/transactions/${transToVoid.id}/void`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('already voided');
    });

    it('should return 404 when voiding a transaction of another merchant', async () => {
      const response = await request(app)
        .patch(`/api/v1/transactions/${transToVoid.id}/void`)
        .set('Authorization', `Bearer ${tokenB}`); // Merchant B voiding Merchant A's transaction

      expect(response.status).toBe(404);
    });
  });

  describe('Regression - Customer Module APIs', () => {
    it('should verify customer creation still functions perfectly', async () => {
      const response = await request(app)
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Transaction Regression Customer',
          phoneNumber: '9111111111',
          lendingRate: 15,
          depositRate: 10,
          compoundingFrequency: CompoundingFrequency.YEARLY,
        });

      expect(response.status).toBe(201);
      expect(response.body.data.customer.name).toBe('Transaction Regression Customer');
    });

    it('should verify customer list endpoint still functions perfectly', async () => {
      const response = await request(app)
        .get('/api/v1/customers')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.customers).toBeDefined();
    });
  });

  describe('Targeted Entry Settlement - Validation & Security', () => {
    let debitA: Transaction;
    let debitB: Transaction;
    let voidedDebit: Transaction;

    beforeEach(async () => {
      await prisma.transaction.deleteMany();

      debitA = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          interestType: InterestType.SIMPLE,
          interestRate: 12,
        },
      });

      debitB = await prisma.transaction.create({
        data: {
          customerId: customerActiveB.id, // Merchant B's customer
          type: TransactionType.DEBIT,
          amount: 2000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          interestType: InterestType.SIMPLE,
          interestRate: 12,
        },
      });

      voidedDebit = await prisma.transaction.create({
        data: {
          customerId: customerActiveA.id,
          type: TransactionType.DEBIT,
          amount: 500,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          isVoided: true,
        },
      });
    });

    it('should successfully create a CREDIT targeting an eligible DEBIT entry', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 500,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: debitA.id,
          remarks: 'Targeted payment to debitA',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.transaction.targetEntryId).toBe(debitA.id);
    });

    it('should reject DEBIT transaction when targetEntryId is provided (400)', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'DEBIT',
          amount: 1000,
          date: '2025-01-01T00:00:00Z',
          interestStartDate: '2025-01-01T00:00:00Z',
          targetEntryId: debitA.id,
        });

      expect(response.status).toBe(400);
      expect(response.body.errors[0].message).toContain(
        'Target entry ID is only allowed for CREDIT',
      );
    });

    it('should reject CREDIT with malformed targetEntryId format (400)', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 500,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: 'not-a-valid-uuid',
        });

      expect(response.status).toBe(400);
      expect(response.body.errors[0].message).toContain('Invalid target entry ID format');
    });

    it('should reject CREDIT targeting a non-existent transaction ID (404)', async () => {
      const nonExistentUuid = 'a0000000-0000-4000-8000-000000000000';
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 500,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: nonExistentUuid,
        });

      expect(response.status).toBe(404);
      expect(response.body.message).toContain('Target debit transaction not found');
    });

    it("should reject CREDIT targeting another merchant's transaction with 404 (multi-tenant security)", async () => {
      // Merchant A attempts to target Merchant B's debit
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 500,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: debitB.id,
        });

      expect(response.status).toBe(404);
      expect(response.body.message).toContain('Target debit transaction not found');
    });

    it('should reject CREDIT targeting a voided transaction (400)', async () => {
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 250,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: voidedDebit.id,
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Cannot target a voided transaction');
    });

    it('should reject CREDIT targeting an already settled debit entry (400)', async () => {
      // 1. Settle debitA with a 1,100 payment on 2025-02-01
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 1100,
          date: '2025-02-01T00:00:00Z',
          interestStartDate: '2025-02-01T00:00:00Z',
          targetEntryId: debitA.id,
        });

      // 2. Attempt another targeted payment to already settled debitA
      const response = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          customerId: customerActiveA.id,
          type: 'CREDIT',
          amount: 500,
          date: '2025-03-01T00:00:00Z',
          interestStartDate: '2025-03-01T00:00:00Z',
          targetEntryId: debitA.id,
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('already fully settled');
    });
  });
});
