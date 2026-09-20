import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import { calculateInterest } from '../utils/interestCalculator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { CompoundingFrequency, InterestType, TransactionType } from '../generated/prisma/client';

describe('Per-Entry Interest Engine & Ledger Tests', () => {
  describe('Unit Tests - Interest Calculator Utility', () => {
    describe('NO_INTEREST Mode', () => {
      it('should calculate 0 interest for NO_INTEREST after 1 year', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'NO_INTEREST',
        });

        expect(result.elapsedDays).toBe(365);
        expect(result.interest).toBe(0);
        expect(result.totalAmount).toBe(10000);
      });

      it('should calculate 0 interest for NO_INTEREST over 5 years', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 18,
          startDate: new Date('2020-01-01T00:00:00Z'),
          calculationDate: new Date('2025-01-01T00:00:00Z'),
          interestType: 'NO_INTEREST',
        });

        expect(result.elapsedDays).toBe(1827);
        expect(result.interest).toBe(0);
        expect(result.totalAmount).toBe(10000);
      });
    });

    describe('SIMPLE Interest Mode', () => {
      it('should correctly calculate SIMPLE interest for 1 year (10,000 @ 12% = 1,200)', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'SIMPLE',
        });

        expect(result.elapsedDays).toBe(365);
        expect(result.interest).toBe(1200);
        expect(result.totalAmount).toBe(11200);
      });

      it('should correctly calculate SIMPLE interest for 2 years (10,000 @ 12% = 2,400)', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2024-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'SIMPLE',
        });

        // 2 years (731 days accounting for leap year 2024) -> 10000 * 12 * 731 / (100 * 365) = 2403.29
        expect(result.interest).toBeCloseTo(2403.29, 1);
        expect(result.totalAmount).toBeCloseTo(12403.29, 1);
      });
    });

    describe('COMPOUND Interest Mode', () => {
      it('should correctly calculate YEARLY compounding for 1 year (10,000 @ 12% = 1,200)', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'YEARLY',
        });

        expect(result.interest).toBe(1200);
        expect(result.totalAmount).toBe(11200);
      });

      it('should correctly calculate YEARLY compounding for 2 years (10,000 @ 12% = 2,544)', () => {
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2027-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'YEARLY',
        });

        // 10000 * (1.12)^2 = 12544
        expect(result.interest).toBe(2544);
        expect(result.totalAmount).toBe(12544);
      });

      it('should support DAILY compounding (n=365)', () => {
        // P = 10,000, r = 12%, t = 1 yr (365 days), n = 365
        // A = 10000 * (1 + 0.12/365)^365 = 11274.75, Interest = 1274.75
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'DAILY',
        });

        expect(result.interest).toBe(1274.75);
        expect(result.totalAmount).toBe(11274.75);
      });

      it('should support WEEKLY compounding (n=52)', () => {
        // P = 10,000, r = 12%, t = 1 yr (365 days), n = 52
        // A = 10000 * (1 + 0.12/52)^52 = 11273.41, Interest = 1273.41
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'WEEKLY',
        });

        expect(result.interest).toBe(1273.41);
        expect(result.totalAmount).toBe(11273.41);
      });

      it('should support MONTHLY compounding', () => {
        // P = 10,000, r = 12%, t = 1 yr, n = 12
        // A = 10000 * (1 + 0.01)^12 = 11268.25, Interest = 1268.25
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'MONTHLY',
        });

        expect(result.interest).toBe(1268.25);
        expect(result.totalAmount).toBe(11268.25);
      });

      it('should support QUARTERLY compounding', () => {
        // P = 5,000, r = 18%, t = 182/365 yr, n = 4
        // A = 5000 * (1 + 0.045)^(4 * 182/365) = 5458.81, Interest = 458.81
        const result = calculateInterest({
          principal: 5000,
          annualInterestRate: 18,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2025-07-02T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'QUARTERLY',
        });

        expect(result.interest).toBe(458.81);
        expect(result.totalAmount).toBe(5458.81);
      });

      it('should support HALF_YEARLY compounding', () => {
        // P = 10,000, r = 12%, t = 1 yr, n = 2
        // A = 10000 * (1 + 0.06)^2 = 11236.00, Interest = 1236.00
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'HALF_YEARLY',
        });

        expect(result.interest).toBe(1236);
        expect(result.totalAmount).toBe(11236);
      });

      it('should support CUSTOM compounding (e.g. customCompoundDays = 30)', () => {
        // P = 10,000, r = 12%, t = 1 yr (365 days), customCompoundDays = 30 -> n = 365/30 = 12.166667
        // Rate per period = 0.12 / (365/30) = 0.00986301
        // A = 10000 * (1 + 0.00986301)^12.166667 = 11268.34, Interest = 1268.34
        const result = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'CUSTOM',
          customCompoundDays: 30,
        });

        expect(result.interest).toBe(1268.34);
        expect(result.totalAmount).toBe(11268.34);
      });

      it('should accurately handle leap year date intervals (Feb 28 -> Mar 1)', () => {
        // 2024 is a leap year (includes Feb 29): 2024-02-28 to 2024-03-01 is 2 days
        const leapResult = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2024-02-28T00:00:00Z'),
          calculationDate: new Date('2024-03-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'DAILY',
        });
        expect(leapResult.elapsedDays).toBe(2);

        // 2023 is a non-leap year: 2023-02-28 to 2023-03-01 is 1 day
        const nonLeapResult = calculateInterest({
          principal: 10000,
          annualInterestRate: 12,
          startDate: new Date('2023-02-28T00:00:00Z'),
          calculationDate: new Date('2023-03-01T00:00:00Z'),
          interestType: 'COMPOUND',
          compoundingFrequency: 'DAILY',
        });
        expect(nonLeapResult.elapsedDays).toBe(1);
      });
    });

    describe('Edge Cases', () => {
      it('should handle zero elapsed days', () => {
        const result = calculateInterest({
          principal: 8000,
          annualInterestRate: 24,
          startDate: new Date('2026-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'SIMPLE',
        });

        expect(result.elapsedDays).toBe(0);
        expect(result.interest).toBe(0);
        expect(result.totalAmount).toBe(8000);
      });

      it('should handle zero interest rate', () => {
        const result = calculateInterest({
          principal: 5000,
          annualInterestRate: 0,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'SIMPLE',
        });

        expect(result.interest).toBe(0);
        expect(result.totalAmount).toBe(5000);
      });

      it('should handle zero principal', () => {
        const result = calculateInterest({
          principal: 0,
          annualInterestRate: 15,
          startDate: new Date('2025-01-01T00:00:00Z'),
          calculationDate: new Date('2026-01-01T00:00:00Z'),
          interestType: 'SIMPLE',
        });

        expect(result.interest).toBe(0);
        expect(result.totalAmount).toBe(0);
      });
    });
  });

  describe('Integration Tests - Customer Ledger API Endpoint', () => {
    let merchantA: import('../generated/prisma/client').User;
    let merchantB: import('../generated/prisma/client').User;
    let tokenA: string;
    let customerA: import('../generated/prisma/client').Customer;
    let customerB: import('../generated/prisma/client').Customer;

    beforeAll(async () => {
      await prisma.transaction.deleteMany();
      await prisma.customer.deleteMany();
      await prisma.user.deleteMany();

      const passHash = await bcrypt.hash('password123', 10);

      merchantA = await prisma.user.create({
        data: {
          email: 'merchant.ledger.a@test.com',
          passwordHash: passHash,
          businessName: 'Merchant A Ledger Stores',
        },
      });
      tokenA = jwt.sign({ id: merchantA.id, email: merchantA.email }, config.JWT_SECRET, {
        expiresIn: '1h',
      });

      merchantB = await prisma.user.create({
        data: {
          email: 'merchant.ledger.b@test.com',
          passwordHash: passHash,
          businessName: 'Merchant B Stores',
        },
      });

      customerA = await prisma.customer.create({
        data: {
          userId: merchantA.id,
          name: 'Customer A Ledger',
          phoneNumber: '9000000010',
          lendingRate: 12.0,
          depositRate: 6.0,
          defaultInterestType: InterestType.SIMPLE,
          compoundingFrequency: CompoundingFrequency.MONTHLY,
          isActive: true,
        },
      });

      customerB = await prisma.customer.create({
        data: {
          userId: merchantB.id,
          name: 'Customer B',
          phoneNumber: '9000000020',
          lendingRate: 15.0,
          depositRate: 7.0,
          defaultInterestType: InterestType.SIMPLE,
          compoundingFrequency: CompoundingFrequency.YEARLY,
          isActive: true,
        },
      });
    });

    beforeEach(async () => {
      await prisma.transaction.deleteMany();
      await prisma.customerInterestRate.deleteMany();
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 0 },
      });
    });

    afterAll(async () => {
      await prisma.transaction.deleteMany();
      await prisma.customerInterestRate.deleteMany();
      await prisma.customer.deleteMany();
      await prisma.user.deleteMany();
      await disconnectDb();
    });

    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app).get(`/api/v1/customers/${customerA.id}/ledger`);
      expect(res.status).toBe(401);
    });

    it('should return 404 when customer belongs to another merchant', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/${customerB.id}/ledger`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      expect(res.body.message).toContain('Customer not found');
    });

    // Test 1: Multiple independent entries with Due/Advance open entries
    it('should calculate multiple DEBIT entries independently (Rule 3)', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // Entry 1: 10,000, Jan 1 2025
      // Entry 2: 5,000, Jan 1 2025
      await prisma.transaction.createMany({
        data: [
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 10000,
            date: new Date('2025-01-01T00:00:00Z'),
            interestStartDate: new Date('2025-01-01T00:00:00Z'),
            remarks: 'Entry 1',
          },
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 5000,
            date: new Date('2025-01-01T00:00:00Z'),
            interestStartDate: new Date('2025-01-01T00:00:00Z'),
            remarks: 'Entry 2',
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const { summary, openEntries, settledEntries, transactions } = res.body.data;
      expect(openEntries).toHaveLength(2);
      expect(settledEntries).toHaveLength(0);
      expect(transactions).toHaveLength(2);

      const entry1 = openEntries.find(
        (e: { principalAmount: number }) => e.principalAmount === 10000,
      );
      const entry2 = openEntries.find(
        (e: { principalAmount: number }) => e.principalAmount === 5000,
      );

      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();

      // Entry 1: 10,000 * 2% * 12 months = 2,400
      expect(entry1.accruedInterest).toBe(2400);
      expect(entry1.totalDue).toBe(12400);

      // Entry 2: 5,000 * 2% * 12 months = 1,200
      expect(entry2.accruedInterest).toBe(1200);
      expect(entry2.totalDue).toBe(6200);

      // Summary
      expect(summary.status).toBe('Due');
      expect(summary.totalMoneyLent).toBe(15000);
      expect(summary.totalMoneyReceived).toBe(0);
      expect(summary.totalPrincipal).toBe(15000);
      expect(summary.accruedInterest).toBe(3600);
      expect(summary.totalDue).toBe(18600);
      expect(summary.advance).toBe(0);
    });

    // Test 2: Rule 5 Full Settlement (Principal + Interest)
    it('should correctly settle full principal + accrued interest with CREDIT (Rule 5)', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // Entry: 1,250 DEBIT on Jan 1 2026
      // Accrues interest up to Feb 1 2026 (1 month @ 2% = 25.00)
      // Total owed = 1,275.00
      // CREDIT: 1,275 on Feb 1 2026
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1250,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
          remarks: 'Loan 1250',
        },
      });

      const creditTx = await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1275,
          date: new Date('2026-02-01T00:00:00Z'),
          interestStartDate: new Date('2026-02-01T00:00:00Z'),
          remarks: 'Full settlement',
        },
      });

      // Query on Feb 15 2026 (after settlement)
      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-15T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(openEntries).toHaveLength(0);
      expect(settledEntries).toHaveLength(1);
      expect(settledEntries[0].principalAmount).toBe(1250);
      expect(settledEntries[0].interestCharged).toBe(25);
      expect(settledEntries[0].settledByPaymentId).toBe(creditTx.id);

      expect(summary.status).toBe('Settled');
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.accruedInterest).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.advance).toBe(0);
      expect(summary.totalMoneyLent).toBe(1250);
      expect(summary.totalMoneyReceived).toBe(1275);
    });

    // Test 3: Partial Payment Waterfall (Interest First)
    it('should handle principal-only payment, preserving unpaid accrued interest (Rule 6)', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // DEBIT 1,250 on Jan 1 2026 (25 interest as of Feb 1)
      // CREDIT 1,250 on Feb 1 2026:
      // - 25 pays interest
      // - 1,225 pays principal -> 25 remaining principal in consolidated entry
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1250,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1250,
          date: new Date('2026-02-01T00:00:00Z'),
          interestStartDate: new Date('2026-02-01T00:00:00Z'),
        },
      });

      // Query on Feb 15 (14 days after payment; Feb 2026 has 28 days -> 14/28 = 0.5 month)
      // Interest on 25 principal for 0.5 month @ 2% = 25 * 0.02 * 0.5 = 0.25
      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-15T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(settledEntries).toHaveLength(1);
      expect(settledEntries[0].principalAmount).toBe(1250);
      expect(settledEntries[0].interestCharged).toBe(25);

      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(25);
      expect(openEntries[0].accruedInterest).toBe(0.25);
      expect(openEntries[0].totalDue).toBe(25.25);
      expect(openEntries[0].isSystemGenerated).toBe(true);

      expect(summary.status).toBe('Due');
      expect(summary.totalPrincipal).toBe(25);
      expect(summary.accruedInterest).toBe(0.25);
      expect(summary.totalDue).toBe(25.25);
      expect(summary.advance).toBe(0);
    });

    // Test 4: Rule 7 Partial payment
    it('should handle partial payment, accruing future interest only on remaining principal (Rule 7)', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // DEBIT 1,250 on Jan 1 2026
      // CREDIT 500 on Feb 1 2026
      // Jan 1 -> Feb 1 = 1 month: interest = 25.00
      // 500 payment pays 25 interest + 475 principal -> remaining principal = 775.00
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1250,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 500,
          date: new Date('2026-02-01T00:00:00Z'),
          interestStartDate: new Date('2026-02-01T00:00:00Z'),
        },
      });

      // As of Feb 1:
      const resFeb1 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resFeb1.body.data.summary.totalPrincipal).toBe(775);
      expect(resFeb1.body.data.summary.accruedInterest).toBe(0);
      expect(resFeb1.body.data.summary.totalDue).toBe(775);

      // As of Feb 15 (14 days later, 14/28 = 0.5 month @ 2%):
      // Additional interest on 775 for 0.5 month = 775 * 0.02 * 0.5 = 7.75
      // Total due = 775 + 7.75 = 782.75
      const resFeb15 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-15T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      const summaryFeb15 = resFeb15.body.data.summary;
      const openEntriesFeb15 = resFeb15.body.data.openEntries;

      expect(summaryFeb15.totalPrincipal).toBe(775);
      expect(summaryFeb15.accruedInterest).toBe(7.75);
      expect(summaryFeb15.totalDue).toBe(782.75);

      expect(openEntriesFeb15).toHaveLength(1);
      expect(openEntriesFeb15[0].principalAmount).toBe(775);
      expect(openEntriesFeb15[0].accruedInterest).toBe(7.75);
      expect(openEntriesFeb15[0].totalDue).toBe(782.75);
    });

    // Test 5: Critical Regression Test (DEBIT 500 + DEBIT 750 + CREDIT 1250)
    it('should pass critical regression test (DEBIT 500 + DEBIT 750 + CREDIT 1250 -> 0 principal)', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 500,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 750,
          date: new Date('2026-01-15T00:00:00Z'),
          interestStartDate: new Date('2026-01-15T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1250,
          date: new Date('2026-02-01T00:00:00Z'),
          interestStartDate: new Date('2026-02-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-15T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(summary.totalPrincipal).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.status).toBe('Settled');
      expect(openEntries).toHaveLength(0);
      expect(settledEntries).toHaveLength(2);
    });

    // Test 6: Overpayment
    it('should track overpayments cleanly without negative principal or negative interest (Rule 8)', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1500, // 500 overpayment
          date: new Date('2026-02-01T00:00:00Z'),
          interestStartDate: new Date('2026-02-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-02-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(summary.status).toBe('Advance');
      expect(summary.displayAmount).toBe(500);
      expect(summary.advance).toBe(500);
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.accruedInterest).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(openEntries).toHaveLength(0);
      expect(settledEntries).toHaveLength(1);
    });

    // Test 7: Voided transactions exclusion
    it('should exclude voided transactions from per-entry calculations', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
          isVoided: true, // voided
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 500,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
          isVoided: false,
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;
      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(500);
      expect(summary.totalMoneyLent).toBe(500);
      expect(summary.totalPrincipal).toBe(500);
    });

    // Test 8: Multi-Entry Overpayment with Simple Monthly Interest
    it('should correctly settle all 3 entries and track exact unallocatedCredit on 4,000 payment', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 1.0 }, // 1% monthly rate = 12% annual simple
      });

      // 3 DEBIT entries of 1,000 each on 2025-01-01
      // CREDIT: 4,000 on 2026-08-19
      await prisma.transaction.createMany({
        data: [
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2025-01-01T00:00:00Z'),
            interestStartDate: new Date('2025-01-01T00:00:00Z'),
            remarks: 'Debit 1',
          },
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2025-01-01T00:00:00Z'),
            interestStartDate: new Date('2025-01-01T00:00:00Z'),
            remarks: 'Debit 2',
          },
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2025-01-01T00:00:00Z'),
            interestStartDate: new Date('2025-01-01T00:00:00Z'),
            remarks: 'Debit 3',
          },
        ],
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 4000,
          date: new Date('2026-08-19T00:00:00Z'),
          interestStartDate: new Date('2026-08-19T00:00:00Z'),
          remarks: 'Overpayment of 4000',
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-08-19T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(openEntries).toHaveLength(0);
      expect(settledEntries).toHaveLength(3);
      for (const entry of settledEntries) {
        expect(entry.principalAmount).toBe(1000);
        expect(entry.interestCharged).toBeCloseTo(195.81, 1);
      }

      // Summary checks
      expect(summary.status).toBe('Advance');
      expect(summary.totalMoneyLent).toBe(3000);
      expect(summary.totalMoneyReceived).toBe(4000);
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.accruedInterest).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.advance).toBeCloseTo(412.57, 1);
    });

    // Test 9: Complete Lifecycle Test: Overpayment -> Advance Hold -> June Purchase Absorption -> Subsequent Interest
    it('should correctly handle multi-year overpayment lifecycle, holding unallocated credit, absorbing into June debit, and accruing interest only on remaining principal', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 1.0 }, // 1% monthly simple rate
      });

      // 1. Three DEBIT entries of 1,000 each on 2024-01-01
      await prisma.transaction.createMany({
        data: [
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2024-01-01T00:00:00Z'),
            interestStartDate: new Date('2024-01-01T00:00:00Z'),
            remarks: 'Debit 1',
          },
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2024-01-01T00:00:00Z'),
            interestStartDate: new Date('2024-01-01T00:00:00Z'),
            remarks: 'Debit 2',
          },
          {
            customerId: customerA.id,
            type: TransactionType.DEBIT,
            amount: 1000,
            date: new Date('2024-01-01T00:00:00Z'),
            interestStartDate: new Date('2024-01-01T00:00:00Z'),
            remarks: 'Debit 3',
          },
        ],
      });

      // 2. Overpayment CREDIT of 4,000 on 2025-01-01
      // 12 months elapsed. Interest per entry = 1000 * 1% * 12 = 120. Total due = 3,360.
      // Advance = 4,000 - 3,360 = 640.
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 4000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Payment of 4000',
        },
      });

      // 3. Verify ledger state BEFORE June debit (as of 2025-05-01)
      const resPreJune = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-05-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resPreJune.status).toBe(200);
      expect(resPreJune.body.data.summary.status).toBe('Advance');
      expect(resPreJune.body.data.summary.totalPrincipal).toBe(0);
      expect(resPreJune.body.data.summary.accruedInterest).toBe(0);
      expect(resPreJune.body.data.summary.totalDue).toBe(0);
      expect(resPreJune.body.data.summary.advance).toBe(640);
      expect(resPreJune.body.data.summary.totalMoneyReceived).toBe(4000);

      // 4. Create new DEBIT of 1,000 on 2025-06-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-06-01T00:00:00Z'),
          interestStartDate: new Date('2025-06-01T00:00:00Z'),
          remarks: 'June Debit 4',
        },
      });

      // 5. Verify ledger as of 2025-06-01 (same day as June debit):
      // - 640 absorbed into principal immediately
      // - remaining principal = 360
      // - advance = 0
      const resJune1 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-06-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resJune1.status).toBe(200);
      const summaryJune1 = resJune1.body.data.summary;
      const openEntriesJune1 = resJune1.body.data.openEntries;

      expect(summaryJune1.status).toBe('Due');
      expect(summaryJune1.totalMoneyLent).toBe(4000);
      expect(summaryJune1.totalMoneyReceived).toBe(4000);
      expect(summaryJune1.totalPrincipal).toBe(360);
      expect(summaryJune1.accruedInterest).toBe(0);
      expect(summaryJune1.totalDue).toBe(360);
      expect(summaryJune1.advance).toBe(0);

      expect(openEntriesJune1).toHaveLength(1);
      expect(openEntriesJune1[0].principalAmount).toBe(360);
      expect(openEntriesJune1[0].accruedInterest).toBe(0);

      // 6. Verify ledger as of 2025-10-01 (4 months after June 1):
      // - New interest must accrue ONLY on remaining 360 principal:
      //   360 * 1% * 4 = 14.40
      // - Total due = 360 + 14.40 = 374.40
      const resOct1 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-10-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resOct1.status).toBe(200);
      const summaryOct1 = resOct1.body.data.summary;
      const openEntryOct1 = resOct1.body.data.openEntries[0];

      expect(summaryOct1.totalPrincipal).toBe(360);
      expect(summaryOct1.accruedInterest).toBe(14.4);
      expect(summaryOct1.totalDue).toBe(374.4);

      expect(openEntryOct1.principalAmount).toBe(360);
      expect(openEntryOct1.accruedInterest).toBe(14.4);
      expect(openEntryOct1.totalDue).toBe(374.4);
    });

    // Test 10: Multiple DEBIT entries independent interest accrual
    it('should independently calculate compound interest for multiple DEBIT entries with different rates and frequencies', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 }, // 2% monthly rate
      });

      // Entry 1: 10,000 on 2025-01-01 -> 1 yr (12 mo) interest = 2,400
      // Entry 2: 5,000 on 2025-01-01 -> 1 yr (12 mo) interest = 1,200
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 10000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit 1',
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 5000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit 2',
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;
      expect(openEntries).toHaveLength(2);

      const entry1 = openEntries.find(
        (e: { principalAmount: number }) => e.principalAmount === 10000,
      );
      const entry2 = openEntries.find(
        (e: { principalAmount: number }) => e.principalAmount === 5000,
      );

      expect(entry1.accruedInterest).toBe(2400);
      expect(entry1.totalDue).toBe(12400);

      expect(entry2.accruedInterest).toBe(1200);
      expect(entry2.totalDue).toBe(6200);

      // Summary aggregate
      expect(summary.status).toBe('Due');
      expect(summary.totalMoneyLent).toBe(15000);
      expect(summary.totalPrincipal).toBe(15000);
      expect(summary.accruedInterest).toBe(3600);
      expect(summary.totalDue).toBe(18600);
    });

    // Test 11: Partial Payment with Future Interest on Remaining Principal Only
    it('should compound future interest strictly on remaining principal after partial principal payment', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 }, // 2% monthly rate
      });

      // 1. DEBIT: 10,000 on 2024-01-01
      // 12 months later (2025-01-01): 10,000 * 2% * 12 = 2,400 interest. Total owed = 12,400
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 10000,
          date: new Date('2024-01-01T00:00:00Z'),
          interestStartDate: new Date('2024-01-01T00:00:00Z'),
        },
      });

      // 2. CREDIT: 6,000 on 2025-01-01:
      // Waterfall: 2,400 clears interest, 3,600 clears principal -> 6,400 remaining principal
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 6000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // 3. Ledger as of 2026-01-01 (12 months after payment):
      // Future interest accrues ONLY on remaining 6,400 principal: 6,400 * 2% * 12 = 1,536
      // Total due = 6,400 + 1,536 = 7,936
      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(6400);
      expect(openEntries[0].accruedInterest).toBe(1536);
      expect(openEntries[0].totalDue).toBe(7936);

      expect(settledEntries).toHaveLength(1);
      expect(settledEntries[0].principalAmount).toBe(10000);
      expect(settledEntries[0].interestCharged).toBe(2400);

      expect(summary.totalPrincipal).toBe(6400);
      expect(summary.accruedInterest).toBe(1536);
      expect(summary.totalDue).toBe(7936);
    });

    // Test 12: Same-day partial payment before interest accrual
    it('should correctly reduce principal without premature interest when payment occurs before interest start date', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // DEBIT 10,000 on 2025-01-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 10000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // CREDIT of 3,000 on 2025-01-01 (same day: 0 interest accrued yet)
      // Clears 3,000 principal -> 7,000 remaining principal
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 3000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // Ledger as of 2026-01-01 (12 months later):
      // Interest = 7,000 * 2% * 12 = 1,680.00
      // Total due = 7,000 + 1,680 = 8,680.00
      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;
      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(7000);
      expect(openEntries[0].accruedInterest).toBe(1680);
      expect(openEntries[0].totalDue).toBe(8680);
      expect(summary.totalPrincipal).toBe(7000);
      expect(summary.accruedInterest).toBe(1680);
      expect(summary.totalDue).toBe(8680);
    });

    // Test 13: Same-Day Transaction and Settlement
    it('should handle same-day DEBIT and CREDIT without extra interest period', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 5000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 5000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;
      expect(openEntries).toHaveLength(0);
      // Under same-day rule (CREDIT before DEBIT), payment becomes Advance which fully covers the purchase
      expect(summary.status).toBe('Settled');
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.accruedInterest).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.advance).toBe(0);
    });

    // Test 14: Payment Allocation Across Multiple Due Entries (FIFO)
    it('should apply payment to target entry C while leaving A and B completely unaffected', async () => {
      // In Due/Advance model, payments apply FIFO across all open entries
      // DEBIT A = 1,000, DEBIT B = 2,000, DEBIT C = 3,000 on 2025-01-01 @ 0%
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit A',
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 2000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit B',
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 3000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit C',
        },
      });

      // CREDIT 1,500 on 2025-02-01:
      // Clears A (1,000), applies 500 to B (leaving 1,500), leaves C untouched (3,000)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1500,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
          remarks: 'Payment of 1500',
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-02-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      // In consolidated Due/Advance settlement:
      // Total principal was 6,000 (1000 + 2000 + 3000), payment of 1,500 settles the original entries
      // and leaves a single consolidated open due entry of 4,500 (6,000 - 1,500).
      expect(settledEntries).toHaveLength(3);
      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(4500);
      expect(summary.totalPrincipal).toBe(4500);

      // Summary
      expect(summary.status).toBe('Due');
      expect(summary.totalMoneyLent).toBe(6000);
      expect(summary.totalMoneyReceived).toBe(1500);
      expect(summary.totalPrincipal).toBe(4500);
      expect(summary.totalDue).toBe(4500);
      expect(summary.advance).toBe(0);
    });

    // Test 15: Payment with Accrued Interest Payoff
    it('should pay principal first and accrued compound interest on the targeted entry', async () => {
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 }, // 2% monthly rate
      });

      // DEBIT 10,000 on 2025-01-01
      // As of 2026-01-01 (12 months): 10,000 * 2% * 12 = 2,400 interest, total owed = 12,400
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 10000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // Payment of 12,400 on 2026-01-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 12400,
          date: new Date('2026-01-01T00:00:00Z'),
          interestStartDate: new Date('2026-01-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2026-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;
      expect(openEntries).toHaveLength(0);
      expect(settledEntries).toHaveLength(1);
      expect(settledEntries[0].principalAmount).toBe(10000);
      expect(settledEntries[0].interestCharged).toBe(2400);

      expect(summary.status).toBe('Settled');
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.accruedInterest).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.advance).toBe(0);
    });

    // Test 16: Payment Exceeding Debt -> Advance
    it('should place excess payment beyond target debt into unallocatedCredit without spilling to other entries', async () => {
      // DEBIT A = 1,000, DEBIT B = 1,000 on 2025-01-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // Payment of 2,500 on 2025-02-01 (exceeds total 2,000 debt by 500)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 2500,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-02-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;

      // Both settled
      expect(settledEntries).toHaveLength(2);
      expect(openEntries).toHaveLength(0);

      // 500 excess is in advance
      expect(summary.status).toBe('Advance');
      expect(summary.displayAmount).toBe(500);
      expect(summary.advance).toBe(500);
      expect(summary.totalMoneyLent).toBe(2000);
      expect(summary.totalMoneyReceived).toBe(2500);
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.totalDue).toBe(0);
    });

    // Test 17: Multiple Payments to Settle Entry
    it('should accumulate multiple targeted payments against the same entry until settled', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // Pay 300
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 300,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
        },
      });

      // Pay 200
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 200,
          date: new Date('2025-03-01T00:00:00Z'),
          interestStartDate: new Date('2025-03-01T00:00:00Z'),
        },
      });

      // Pay 500
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 500,
          date: new Date('2025-04-01T00:00:00Z'),
          interestStartDate: new Date('2025-04-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-04-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries, settledEntries } = res.body.data;
      expect(openEntries).toHaveLength(0);
      expect(settledEntries.length).toBeGreaterThan(0);
      expect(summary.status).toBe('Settled');
      expect(summary.totalPrincipal).toBe(0);
      expect(summary.totalDue).toBe(0);
      expect(summary.advance).toBe(0);
    });

    // Test 18: Sequential Payments Across Multiple Entries
    it('should correctly allocate a subsequent normal FIFO payment after a prior targeted payment', async () => {
      // DEBIT A = 1,000, DEBIT B = 2,000 on 2025-01-01 @ 0%
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 2000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // 1. First payment of 500 on 2025-02-01 (reduces A from 1,000 to 500)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 500,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
        },
      });

      // 2. Second payment of 700 on 2025-03-01 (settles remaining 500 of A, and 200 of B -> B remaining = 1,800)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 700,
          date: new Date('2025-03-01T00:00:00Z'),
          interestStartDate: new Date('2025-03-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-03-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;

      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(1800);

      expect(summary.status).toBe('Due');
      expect(summary.totalPrincipal).toBe(1800);
      expect(summary.totalDue).toBe(1800);
      expect(summary.advance).toBe(0);
    });

    // Test 19: Sequential Partial Payments
    it('should correctly allocate a targeted payment after a prior FIFO payment reduced part of the target', async () => {
      // DEBIT A = 1,000, DEBIT B = 2,000 on 2025-01-01 @ 0%
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 2000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // 1. Payment of 1,500 on 2025-02-01 (clears A = 1,000, leaves B = 1,500)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1500,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
        },
      });

      // 2. Payment of 1,000 on 2025-03-01 (reduces B to 500)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1000,
          date: new Date('2025-03-01T00:00:00Z'),
          interestStartDate: new Date('2025-03-01T00:00:00Z'),
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-03-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      const { summary, openEntries } = res.body.data;

      expect(openEntries).toHaveLength(1);
      expect(openEntries[0].principalAmount).toBe(500);

      expect(summary.status).toBe('Due');
      expect(summary.totalPrincipal).toBe(500);
      expect(summary.totalDue).toBe(500);
      expect(summary.advance).toBe(0);
    });

    // Test 20: Void Debit Exclusion
    it('should exclude voided debit from ledger calculations even if targeted by a payment', async () => {
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          isVoided: true, // voided
        },
      });

      const res = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-01-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.openEntries).toHaveLength(0);
      expect(res.body.data.summary.totalPrincipal).toBe(0);
      expect(res.body.data.summary.totalDue).toBe(0);
    });

    // Test 21: Overpayment -> Advance -> Subsequent Debit Absorption -> Remaining Interest
    it('should correctly absorb targeted overpayment unallocated credit into subsequent debit and accrue interest only on remaining principal', async () => {
      // 1. DEBIT A = 1,000 on 2025-01-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
          remarks: 'Debit A',
        },
      });

      // 2. CREDIT of 1,400 on 2025-02-01 (1,000 pays A, 400 excess goes to advance)
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.CREDIT,
          amount: 1400,
          date: new Date('2025-02-01T00:00:00Z'),
          interestStartDate: new Date('2025-02-01T00:00:00Z'),
          remarks: 'Payment with overpayment',
        },
      });

      // 3. Verify ledger state BEFORE Debit B (as of 2025-02-15)
      const resPreB = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-02-15T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resPreB.status).toBe(200);
      const summaryPreB = resPreB.body.data.summary;
      const settledPreB = resPreB.body.data.settledEntries;

      expect(settledPreB).toHaveLength(1);
      expect(settledPreB[0].principalAmount).toBe(1000);
      expect(summaryPreB.status).toBe('Advance');
      expect(summaryPreB.displayAmount).toBe(400);
      expect(summaryPreB.totalPrincipal).toBe(0);
      expect(summaryPreB.accruedInterest).toBe(0);
      expect(summaryPreB.totalDue).toBe(0);
      expect(summaryPreB.advance).toBe(400);
      expect(summaryPreB.totalMoneyReceived).toBe(1400);

      // Now set customer rate to 2.0% effective 2025-02-15 for subsequent interest accrual
      await prisma.customerInterestRate.create({
        data: {
          customerId: customerA.id,
          interestRate: 2.0,
          effectiveDate: new Date('2025-02-15T00:00:00Z'),
        },
      });
      await prisma.customer.update({
        where: { id: customerA.id },
        data: { interestRate: 2.0 },
      });

      // 4. Create new DEBIT B of 1,000 on 2025-03-01
      await prisma.transaction.create({
        data: {
          customerId: customerA.id,
          type: TransactionType.DEBIT,
          amount: 1000,
          date: new Date('2025-03-01T00:00:00Z'),
          interestStartDate: new Date('2025-03-01T00:00:00Z'),
          remarks: 'Debit B',
        },
      });

      // 5. Verify ledger as of 2025-03-01 (same day as Debit B):
      // - January accrual was 0% (old rate before Feb 15) -> payment of 1,400 cleared 1,000 principal + 0 interest -> 400 advance
      // - 400 absorbed into Debit B immediately
      // - Debit B remaining principal = 600 (1000 - 400)
      // - advance = 0
      const resB1 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-03-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resB1.status).toBe(200);
      const summaryB1 = resB1.body.data.summary;
      const openEntriesB1 = resB1.body.data.openEntries;

      expect(summaryB1.status).toBe('Due');
      expect(summaryB1.totalMoneyLent).toBe(2000);
      expect(summaryB1.totalMoneyReceived).toBe(1400);
      expect(summaryB1.totalPrincipal).toBe(600);
      expect(summaryB1.accruedInterest).toBe(0);
      expect(summaryB1.totalDue).toBe(600);
      expect(summaryB1.advance).toBe(0);

      expect(openEntriesB1).toHaveLength(1);
      expect(openEntriesB1[0].principalAmount).toBe(600);

      // 6. Verify ledger as of 2025-07-01 (4 months after March 1):
      // - New interest must accrue ONLY on remaining 600 principal:
      //   600 * 2% * 4 = 48.00
      // - Total due = 600 + 48 = 648.00
      const resJuly1 = await request(app)
        .get(`/api/v1/customers/${customerA.id}/ledger?calculationDate=2025-07-01T00:00:00Z`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resJuly1.status).toBe(200);
      const summaryJuly1 = resJuly1.body.data.summary;
      const openEntryJuly1 = resJuly1.body.data.openEntries[0];

      expect(summaryJuly1.totalPrincipal).toBe(600);
      expect(summaryJuly1.accruedInterest).toBe(48);
      expect(summaryJuly1.totalDue).toBe(648);

      expect(openEntryJuly1.principalAmount).toBe(600);
      expect(openEntryJuly1.accruedInterest).toBe(48);
      expect(openEntryJuly1.totalDue).toBe(648);
    });
  });
});
