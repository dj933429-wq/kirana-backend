import { Decimal } from 'decimal.js';
import request from 'supertest';
import app from '../app';
import { prisma, disconnectDb } from '../config/database';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { TransactionType } from '../generated/prisma/client';
import {
  computeEntryInterest,
  computeSettlement,
  getBalanceStatus,
  replayTransactions,
  DueAdvanceEngine,
  RateChange,
} from '../utils/dueAdvanceEngine';

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

describe('Non-Retroactive Interest Rate Changes Suite', () => {
  // =========================================================================
  // Pure Engine Unit Tests: Scenarios A through L
  // =========================================================================
  describe('Engine Unit Tests - Rate Schedule Calculations', () => {
    // A. No rate change - all periods use the same rate
    test('Scenario A: No rate change - single rate applied across all periods', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(2) },
      ];
      const result = computeEntryInterest(
        new Decimal(10000),
        utc(2025, 1, 1),
        utc(2025, 4, 1), // 3 months
        schedule,
      );
      // 10,000 * 2% * 3 = 600.00
      expect(result.monthsElapsed.toNumber()).toBe(3);
      expect(result.accruedInterest.toNumber()).toBe(600);
      expect(result.interest.toNumber()).toBe(600);
    });

    // B. Rate increase - old rate before effective date, new rate after effective date
    test('Scenario B: Rate increase (1% -> 2%) - Jan interest never recalculated at 2%', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
      ];
      const result = computeEntryInterest(
        new Decimal(1000),
        utc(2025, 1, 1),
        utc(2025, 3, 1), // 2 months
        schedule,
      );
      // Jan 1 -> Feb 1 (1 mo @ 1%): 1,000 * 1% * 1 = 10.00
      // Feb 1 -> Mar 1 (1 mo @ 2%): 1,000 * 2% * 1 = 20.00
      // Total interest: 10 + 20 = 30.00 (NOT 40.00!)
      expect(result.monthsElapsed.toNumber()).toBe(2);
      expect(result.accruedInterest.toNumber()).toBe(30);
      expect(result.interest.toNumber()).toBe(30);
    });

    // C. Rate decrease - old rate before effective date, lower new rate after effective date
    test('Scenario C: Rate decrease (3% -> 1%) - Jan uses 3%, Feb uses 1%', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(3) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(1) },
      ];
      const result = computeEntryInterest(
        new Decimal(2000),
        utc(2025, 1, 1),
        utc(2025, 3, 1),
        schedule,
      );
      // Jan 1 -> Feb 1: 2,000 * 3% * 1 = 60.00
      // Feb 1 -> Mar 1: 2,000 * 1% * 1 = 20.00
      // Total = 80.00 (NOT 40.00 if retroactively decreased)
      expect(result.accruedInterest.toNumber()).toBe(80);
      expect(result.interest.toNumber()).toBe(80);
    });

    // D. Multiple rate changes (1% -> 2% -> 3%)
    test('Scenario D: Multiple rate changes (1% -> 2% -> 3%) each segment uses correct rate', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
        { effectiveDate: utc(2025, 3, 1), monthlyRatePercent: new Decimal(3) },
      ];
      const result = computeEntryInterest(
        new Decimal(10000),
        utc(2025, 1, 1),
        utc(2025, 4, 1),
        schedule,
      );
      // Jan 1 -> Feb 1: 10,000 * 1% * 1 = 100.00
      // Feb 1 -> Mar 1: 10,000 * 2% * 1 = 200.00
      // Mar 1 -> Apr 1: 10,000 * 3% * 1 = 300.00
      // Total = 600.00
      expect(result.monthsElapsed.toNumber()).toBe(3);
      expect(result.accruedInterest.toNumber()).toBe(600);
    });

    // E. Rate change on exact month boundary
    test('Scenario E: Rate change exactly on month boundary transition', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(2) },
        { effectiveDate: utc(2025, 4, 1), monthlyRatePercent: new Decimal(4) },
      ];
      // Period Jan 1 to Apr 1 (exact boundary): only 2% applies up to Apr 1
      const resPre = computeEntryInterest(
        new Decimal(5000),
        utc(2025, 1, 1),
        utc(2025, 4, 1),
        schedule,
      );
      expect(resPre.accruedInterest.toNumber()).toBe(300); // 5000 * 2% * 3 = 300

      // Period Jan 1 to May 1: 3 mo @ 2% + 1 mo @ 4%
      const resPost = computeEntryInterest(
        new Decimal(5000),
        utc(2025, 1, 1),
        utc(2025, 5, 1),
        schedule,
      );
      // 300 + (5000 * 4% * 1 = 200) = 500.00
      expect(resPost.accruedInterest.toNumber()).toBe(500);
    });

    // F. Rate change in middle of a month
    test('Scenario F: Mid-month rate change (Jan 15) calendar-day proration', () => {
      // Defined Semantics:
      // January has 31 days.
      // Jan 1 -> Jan 15: 14 days / 31 days in Jan @ 1.0% = (14/31) month
      // Jan 15 -> Feb 1: 17 days / 31 days in Jan @ 2.0% = (17/31) month
      // Sum of months = 14/31 + 17/31 = 31/31 = 1.0 month exactly.
      // On principal ₹3,100:
      // Part 1: 3,100 * 0.01 * (14/31) = 14.00
      // Part 2: 3,100 * 0.02 * (17/31) = 34.00
      // Total accrued = 14.00 + 34.00 = 48.00
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 1, 15), monthlyRatePercent: new Decimal(2) },
      ];
      const result = computeEntryInterest(
        new Decimal(3100),
        utc(2025, 1, 1),
        utc(2025, 2, 1),
        schedule,
      );
      expect(result.monthsElapsed.toNumber()).toBe(1);
      expect(result.accruedInterest.toNumber()).toBe(48);
    });

    // G. Rate change with partial payment
    test('Scenario G: Rate change with partial payment on Feb 15', () => {
      // Jan 1: Purchase ₹1,000 @ 1%
      // Feb 1: Rate changes to 2%
      // Feb 15: Payment of ₹500
      //   - Jan 1 -> Feb 1: 1.0 mo @ 1% = 10.00
      //   - Feb 1 -> Feb 15: 14/28 = 0.5 mo @ 2% = 10.00
      //   - Total interest charged = 20.00. Total owed = 1020.00.
      //   - 500 pays 20 interest + 480 principal -> consolidated due entry with 520 principal.
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
      ];

      const dueEntries = [
        {
          date: utc(2025, 1, 1),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
      ];

      const settlement = computeSettlement(dueEntries, 500, utc(2025, 2, 15), schedule);
      expect(settlement.totalInterest.toNumber()).toBe(20);
      expect(settlement.totalPrincipal.toNumber()).toBe(1000);
      expect(settlement.totalOwed.toNumber()).toBe(1020);
      expect(settlement.newConsolidatedEntry?.principalAmount.toNumber()).toBe(520);
      expect(settlement.newConsolidatedEntry?.unpaidInterest.toNumber()).toBe(0);

      // Now accrue on remaining ₹520 from Feb 15 to Mar 1 (14 days in Feb @ 2%)
      const nextAccrual = computeEntryInterest(
        new Decimal(520),
        utc(2025, 2, 15),
        utc(2025, 3, 1),
        schedule,
      );
      // 520 * 0.02 * (14/28 = 0.5) = 5.20
      expect(nextAccrual.accruedInterest.toNumber()).toBe(5.2);
    });

    // H. Rate change with unpaid interest (underpayment)
    test('Scenario H: Rate change with unpaid interest preserves principal and tracks shortfall', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
      ];

      const dueEntries = [
        {
          date: utc(2025, 1, 1),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
      ];

      // Total interest at Feb 15 is 20.00. Payment is only 5.00.
      const settlement = computeSettlement(dueEntries, 5, utc(2025, 2, 15), schedule);
      expect(settlement.totalInterest.toNumber()).toBe(20);
      expect(settlement.newConsolidatedEntry?.principalAmount.toNumber()).toBe(1000); // principal untouched!
      expect(settlement.newConsolidatedEntry?.unpaidInterest.toNumber()).toBe(15); // 20 - 5 = 15 unpaid interest

      // On Mar 1: Unpaid interest carries over without compounding
      const status = getBalanceStatus(
        new Decimal(0),
        [
          {
            date: utc(2025, 2, 15),
            principalAmount: new Decimal(1000),
            unpaidInterest: new Decimal(15),
            originTransactionId: null,
            originPaymentId: 'pay1',
          },
        ],
        utc(2025, 3, 1),
        schedule,
      );
      // Accrual from Feb 15 to Mar 1 @ 2% on 1,000 principal: 1,000 * 0.02 * 0.5 = 10.00
      // Total interest = 10.00 + 15.00 = 25.00
      expect(status.accruedInterest).toBe(25);
      expect(status.unpaidInterest).toBe(15);
      expect(status.totalDue).toBe(1000); // principal due
      expect(status.displayAmount.toNumber()).toBe(1025); // principal + total interest
    });

    // I. Rate change with multiple outstanding purchases
    test('Scenario I: Multiple outstanding purchases each accrue according to their own timeline', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
      ];

      const events = [
        {
          id: 'tx1',
          type: 'DEBIT' as const,
          date: utc(2025, 1, 1),
          amount: new Decimal(1000),
        },
        {
          id: 'tx2',
          type: 'DEBIT' as const,
          date: utc(2025, 1, 15),
          amount: new Decimal(3100),
        },
      ];

      const state = replayTransactions(events, schedule);
      expect(state.openDueEntries).toHaveLength(2);

      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        utc(2025, 3, 1),
        schedule,
      );
      // Entry 1 (1000): Jan 1->Feb 1 (10) + Feb 1->Mar 1 (20) = 30.00
      // Entry 2 (3100): Jan 15->Feb 1 (17 days: 3100 * 0.01 * 17/31 = 17.00) + Feb 1->Mar 1 (1 mo @ 2%: 3100 * 0.02 = 62.00) = 79.00
      // Total interest: 30 + 79 = 109.00
      expect(status.totalPrincipal.toNumber()).toBe(4100);
      expect(status.totalInterest.toNumber()).toBe(109);
      expect(status.displayAmount.toNumber()).toBe(4209);
    });

    // J. Rate change with Advance - Advance NEVER accrues interest
    test('Scenario J: Advance never accrues interest regardless of multiple rate changes', () => {
      const engine = new DueAdvanceEngine([
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
      ]);
      engine.processPayment(5000, utc(2025, 1, 1));
      expect(engine.advance.toNumber()).toBe(5000);

      // Increase rate to 5% then 10%
      engine.setRate(5, utc(2025, 2, 1));
      engine.setRate(10, utc(2025, 3, 1));

      const status = engine.getBalanceStatus(utc(2025, 6, 1));
      expect(status.status).toBe('Advance');
      expect(status.advance).toBe(5000);
      expect(status.displayAmount.toNumber()).toBe(5000);
      expect(status.accruedInterest).toBe(0);
      expect(status.totalDue).toBe(0);
    });

    // K. Rate change followed by overpayment and later purchase
    test('Scenario K: Overpayment clears debt under old rate, absorbs subsequent purchase under new rate', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 2, 1), monthlyRatePercent: new Decimal(2) },
      ];

      const events = [
        { id: 'tx1', type: 'DEBIT' as const, date: utc(2025, 1, 1), amount: new Decimal(1000) },
        { id: 'pay1', type: 'CREDIT' as const, date: utc(2025, 2, 1), amount: new Decimal(1500) },
        { id: 'tx2', type: 'DEBIT' as const, date: utc(2025, 3, 1), amount: new Decimal(1000) },
      ];

      const state = replayTransactions(events, schedule);
      // tx1 accrued 10.00 interest in January. Total owed = 1010.
      // Payment 1500 settles tx1; remaining 490 becomes Advance.
      // tx2 on March 1 of 1,000 absorbs 490 advance -> leaves 510 open due entry.
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(510);

      // Ledger as of Apr 1 (1 month later @ 2%): 510 * 2% * 1 = 10.20
      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        utc(2025, 4, 1),
        schedule,
      );
      expect(status.totalPrincipal.toNumber()).toBe(510);
      expect(status.accruedInterest).toBe(10.2);
      expect(status.displayAmount.toNumber()).toBe(520.2);
    });

    // L. Historical replay determinism
    test('Scenario L: Replaying event sequence multiple times produces identical deterministic output', () => {
      const schedule: RateChange[] = [
        { effectiveDate: utc(2025, 1, 1), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: utc(2025, 3, 1), monthlyRatePercent: new Decimal(2.5) },
      ];
      const events = [
        { id: 'tx1', type: 'DEBIT' as const, date: utc(2025, 1, 1), amount: new Decimal(2000) },
        { id: 'tx2', type: 'DEBIT' as const, date: utc(2025, 2, 1), amount: new Decimal(3000) },
        { id: 'pay1', type: 'CREDIT' as const, date: utc(2025, 3, 1), amount: new Decimal(2500) },
        { id: 'tx3', type: 'DEBIT' as const, date: utc(2025, 4, 1), amount: new Decimal(1500) },
      ];

      const state1 = replayTransactions(events, schedule);
      const state2 = replayTransactions(events, schedule);

      expect(state1.advance.toNumber()).toBe(state2.advance.toNumber());
      expect(state1.openDueEntries.length).toBe(state2.openDueEntries.length);
      expect(state1.settledHistory.length).toBe(state2.settledHistory.length);
      expect(state1.settledHistory[0].interestCharged.toNumber()).toBe(
        state2.settledHistory[0].interestCharged.toNumber(),
      );
    });
  });

  // =========================================================================
  // Integration Test: Scenario M (ABC Traders Timeline with Rate Change)
  // =========================================================================
  describe('Integration Tests - Customer Ledger API Endpoint Rate Changes', () => {
    let merchant: import('../generated/prisma/client').User;
    let token: string;
    let customer: import('../generated/prisma/client').Customer;

    beforeAll(async () => {
      await prisma.transaction.deleteMany();
      await prisma.customerInterestRate.deleteMany();
      await prisma.customer.deleteMany();
      await prisma.user.deleteMany();

      const passHash = await bcrypt.hash('password123', 10);
      merchant = await prisma.user.create({
        data: {
          email: 'merchant.rate.test@example.com',
          passwordHash: passHash,
          businessName: 'Rate Test Traders',
        },
      });
      token = jwt.sign({ id: merchant.id, email: merchant.email }, config.JWT_SECRET, {
        expiresIn: '1h',
      });

      customer = await prisma.customer.create({
        data: {
          userId: merchant.id,
          name: 'Rate Test Customer',
          phoneNumber: '9888877777',
          lendingRate: 12.0,
          depositRate: 6.0,
          interestRate: 1.0, // initial 1%
          isActive: true,
        },
      });

      await prisma.customerInterestRate.create({
        data: {
          customerId: customer.id,
          interestRate: 1.0,
          effectiveDate: new Date('2025-01-01T00:00:00Z'),
        },
      });
    });

    afterAll(async () => {
      await prisma.transaction.deleteMany();
      await prisma.customerInterestRate.deleteMany();
      await prisma.customer.deleteMany();
      await prisma.user.deleteMany();
      await disconnectDb();
    });

    test('Scenario M: ABC Traders multi-month timeline with rate change inserted at Month 3', async () => {
      // Month 1 (Jan 1): Purchase ₹10,000 @ 1%
      await prisma.transaction.create({
        data: {
          customerId: customer.id,
          type: TransactionType.DEBIT,
          amount: 10000,
          date: new Date('2025-01-01T00:00:00Z'),
          interestStartDate: new Date('2025-01-01T00:00:00Z'),
        },
      });

      // Month 2 (Feb 1): Check ledger - 1 month elapsed @ 1% -> interest ₹100.00
      const resFeb = await request(app)
        .get(`/api/v1/customers/${customer.id}/ledger?calculationDate=2025-02-01T00:00:00Z`)
        .set('Authorization', `Bearer ${token}`);
      expect(resFeb.status).toBe(200);
      expect(resFeb.body.data.summary.accruedInterest).toBe(100);
      expect(resFeb.body.data.summary.totalDue).toBe(10100);

      // Now insert rate change: Effective Feb 1, rate increases to 2.0%
      await request(app)
        .patch(`/api/v1/customers/${customer.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          interestRate: 2.0,
          effectiveDate: '2025-02-01T00:00:00Z',
        });

      // Month 3 (Mar 1): Check ledger
      // Jan 1 -> Feb 1 (1 mo @ 1%) = 100
      // Feb 1 -> Mar 1 (1 mo @ 2%) = 200
      // Total accrued interest = 300.00 (January was NOT retroactively updated to 200!)
      const resMar = await request(app)
        .get(`/api/v1/customers/${customer.id}/ledger?calculationDate=2025-03-01T00:00:00Z`)
        .set('Authorization', `Bearer ${token}`);
      expect(resMar.status).toBe(200);
      expect(resMar.body.data.summary.accruedInterest).toBe(300);
      expect(resMar.body.data.summary.totalPrincipal).toBe(10000);
      expect(resMar.body.data.summary.totalDue).toBe(10300);

      // Payment on Mar 1 of ₹5,300:
      // Clears ₹300 interest and ₹5,000 principal -> leaves ₹5,000 principal
      await prisma.transaction.create({
        data: {
          customerId: customer.id,
          type: TransactionType.CREDIT,
          amount: 5300,
          date: new Date('2025-03-01T00:00:00Z'),
          interestStartDate: new Date('2025-03-01T00:00:00Z'),
        },
      });

      // Month 4 (Apr 1): Check ledger (1 mo after payment @ 2% on remaining ₹5,000)
      // 5,000 * 2% * 1 = 100.00
      const resApr = await request(app)
        .get(`/api/v1/customers/${customer.id}/ledger?calculationDate=2025-04-01T00:00:00Z`)
        .set('Authorization', `Bearer ${token}`);
      expect(resApr.status).toBe(200);
      expect(resApr.body.data.summary.totalPrincipal).toBe(5000);
      expect(resApr.body.data.summary.accruedInterest).toBe(100);
      expect(resApr.body.data.summary.totalDue).toBe(5100);
    });
  });
});
