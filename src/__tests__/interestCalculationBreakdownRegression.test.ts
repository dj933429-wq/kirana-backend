/**
 * Regression Test Suite: Interest Calculation Breakdown & Contradiction Verification
 *
 * Investigates the frontend screenshot discrepancy:
 * - Transaction Date: 2025-04-30
 * - Calculation Date: 2026-09-19
 * - Duration: 507 days
 * - Contradiction: Principal = ₹0.00, Accrued Interest = ₹2.67, Effective Remaining Total = ₹4,067.37
 *
 * Verifies that:
 * 1. The backend never produces a contradictory financial state (e.g. principal = 0 with interest > 0).
 * 2. Independent first-principles calculation confirms backend engine accuracy.
 * 3. Handles all related accounting cases (normal debit, multiple debits, partial payment, advance,
 *    rate changes, leap year, month-end, same-day credit+debit).
 */

import { Decimal } from 'decimal.js';
import {
  replayTransactions,
  getBalanceStatus,
  computeEntryInterest,
  computeMonthsElapsed,
  TransactionEvent,
  RateChange,
} from '../utils/dueAdvanceEngine';

describe('Regression: Interest Calculation Breakdown & Contradiction Audit', () => {
  const round2 = (d: Decimal): number => Math.round((d.toNumber() + Number.EPSILON) * 100) / 100;

  describe('1. Exact Screenshot Scenario Reproduction (2025-04-30 → 2026-09-19)', () => {
    const startDate = new Date('2025-04-30T00:00:00.000Z');
    const calcDate = new Date('2026-09-19T00:00:00.000Z');
    const monthlyRatePercent = new Decimal(2); // 2% monthly = 24% annual
    const rateSchedule: RateChange[] = [{ effectiveDate: new Date(0), monthlyRatePercent }];

    it('independently calculates calendar duration as 507 days', () => {
      const msPerDay = 1000 * 60 * 60 * 24;
      const elapsedDays = Math.round((calcDate.getTime() - startDate.getTime()) / msPerDay);
      expect(elapsedDays).toBe(507);
    });

    it('proves that ₹0.00 principal CANNOT produce ₹2.67 interest in the backend', () => {
      // If principal was truly 0, interest MUST be 0
      const zeroPrincipal = new Decimal(0);
      const res = computeEntryInterest(zeroPrincipal, startDate, calcDate, rateSchedule);

      expect(res.interest.toNumber()).toBe(0);
      expect(round2(zeroPrincipal.plus(res.interest))).toBe(0);
    });

    it('proves that a ₹4,064.70 debit from 2025-04-30 accrues full months interest, NOT ₹2.67', () => {
      const principal = new Decimal('4064.70');

      // Independent calculation:
      // 2025-04-30 to 2026-08-30 = 16 months
      // 2026-08-30 to 2026-09-19 = 20 days. Days in month of August (start month of partial) = 31 days.
      // Expected partial = 20 / 31 = 0.64516129...
      // Expected total months = 16 + 20/31 = 16.64516129...
      const expectedMonths = new Decimal(16).plus(new Decimal(20).dividedBy(31));
      const expectedInterest = principal.mul(monthlyRatePercent).div(100).mul(expectedMonths);

      const res = computeEntryInterest(principal, startDate, calcDate, rateSchedule);

      // Verify months elapsed matches independent calculation
      const engineMonths = computeMonthsElapsed(startDate, calcDate);
      expect(round2(engineMonths)).toBe(round2(expectedMonths)); // 16.65 months

      // Accrued interest on ₹4,064.70 for 16.65 months is ~₹1,353.15, NOT ₹2.67
      expect(round2(res.interest)).toBe(round2(expectedInterest));
      expect(round2(res.interest)).toBe(1353.15);
      expect(round2(principal.plus(res.interest))).toBe(5417.85);

      // Explicit proof: ₹4,067.37 and ₹2.67 are NOT produced by the backend for this transaction
      expect(round2(res.interest)).not.toBe(2.67);
      expect(round2(principal.plus(res.interest))).not.toBe(4067.37);
    });

    it('proves that ₹2.67 corresponds to exactly 1 day of simple interest on ₹4,064.70 at 24% annual rate', () => {
      // Independent proof of frontend root cause:
      // The frontend displayed Accrued Interest = ₹2.67.
      // 4064.70 * 0.24 / 365 = 2.67267... ≈ ₹2.67!
      const principal = 4064.7;
      const annualRate = 0.24;
      const oneDayInterest = (principal * annualRate) / 365;
      const roundedOneDay = Math.round((oneDayInterest + Number.EPSILON) * 100) / 100;

      expect(roundedOneDay).toBe(2.67);
      expect(Math.round((principal + roundedOneDay + Number.EPSILON) * 100) / 100).toBe(4067.37);
    });

    it('full transaction replay through backend engine produces consistent non-zero principal and interest', () => {
      const events: TransactionEvent[] = [
        {
          id: 'txn-1',
          type: 'DEBIT',
          date: startDate,
          amount: new Decimal('4064.70'),
        },
      ];

      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(4064.7);
      expect(state.advance.toNumber()).toBe(0);

      const status = getBalanceStatus(state.advance, state.openDueEntries, calcDate, rateSchedule);
      expect(status.status).toBe('Due');
      expect(round2(status.totalPrincipal)).toBe(4064.7);
      expect(round2(status.totalInterest)).toBe(1353.15);
      expect(round2(status.displayAmount)).toBe(5417.85);
    });
  });

  describe('2. Invariant: Prevention of Contradictory States', () => {
    const rateSchedule: RateChange[] = [
      { effectiveDate: new Date(0), monthlyRatePercent: new Decimal(2) },
    ];

    it('backend never produces principal = 0 with interest > 0 on an open due entry', () => {
      const events: TransactionEvent[] = [
        {
          id: 'txn-deb',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
        {
          id: 'txn-cred',
          type: 'CREDIT',
          date: new Date('2026-02-01T00:00:00.000Z'),
          amount: new Decimal(1020), // Settles 1000 principal + 20 interest
        },
      ];

      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(0);

      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-03-01T00:00:00.000Z'),
        rateSchedule,
      );

      expect(status.status).toBe('Settled');
      expect(status.totalPrincipal.toNumber()).toBe(0);
      expect(status.totalInterest.toNumber()).toBe(0);
      expect(status.displayAmount.toNumber()).toBe(0);
    });

    it('backend never produces totalDue > 0 when status is Settled or Advance', () => {
      const events: TransactionEvent[] = [
        {
          id: 'txn-adv',
          type: 'CREDIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(500),
        },
      ];

      const state = replayTransactions(events, rateSchedule);
      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-06-01T00:00:00.000Z'),
        rateSchedule,
      );

      expect(status.status).toBe('Advance');
      expect(status.totalPrincipal.toNumber()).toBe(0);
      expect(status.totalInterest.toNumber()).toBe(0);
      expect(status.totalDue).toBe(0);
      expect(status.advance).toBe(500);
    });
  });

  describe('3. Related Accounting Cases & Invariants', () => {
    const rateSchedule: RateChange[] = [
      { effectiveDate: new Date(0), monthlyRatePercent: new Decimal(2) },
    ];

    it('Case 1: Normal DEBIT accrues interest accurately', () => {
      const events: TransactionEvent[] = [
        {
          id: 't1',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-03-01T00:00:00.000Z'), // 2 months
        rateSchedule,
      );
      // Independent: 1000 * 0.02 * 2 = 40
      expect(status.status).toBe('Due');
      expect(round2(status.totalPrincipal)).toBe(1000);
      expect(round2(status.totalInterest)).toBe(40);
      expect(round2(status.displayAmount)).toBe(1040);
    });

    it('Case 2: Multiple DEBITs track independent accruals without leaking values', () => {
      const events: TransactionEvent[] = [
        {
          id: 'd1',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
        {
          id: 'd2',
          type: 'DEBIT',
          date: new Date('2026-02-01T00:00:00.000Z'),
          amount: new Decimal(2000),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(2);

      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-03-01T00:00:00.000Z'),
        rateSchedule,
      );
      // Independent:
      // d1 (Jan 1 -> Mar 1 = 2 months): 1000 * 0.02 * 2 = 40
      // d2 (Feb 1 -> Mar 1 = 1 month):  2000 * 0.02 * 1 = 40
      // Total interest: 80, Total principal: 3000, Total due: 3080
      expect(round2(status.totalPrincipal)).toBe(3000);
      expect(round2(status.totalInterest)).toBe(80);
      expect(round2(status.displayAmount)).toBe(3080);
    });

    it('Case 3: Multiple DEBITs on the same date preserve separate entries', () => {
      const events: TransactionEvent[] = [
        {
          id: 'same-1',
          type: 'DEBIT',
          date: new Date('2026-01-15T00:00:00.000Z'),
          amount: new Decimal(500),
        },
        {
          id: 'same-2',
          type: 'DEBIT',
          date: new Date('2026-01-15T00:00:00.000Z'),
          amount: new Decimal(1500),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(2);
      expect(round2(state.openDueEntries[0].principalAmount)).toBe(500);
      expect(round2(state.openDueEntries[1].principalAmount)).toBe(1500);
    });

    it('Case 4: Partial payment covers interest first, then reduces principal', () => {
      // Jan 1: purchase 1000
      // Feb 1: interest = 20. Payment of 120 -> 20 clears interest, 100 reduces principal to 900
      const events: TransactionEvent[] = [
        {
          id: 'p1',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
        {
          id: 'pay1',
          type: 'CREDIT',
          date: new Date('2026-02-01T00:00:00.000Z'),
          amount: new Decimal(120),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(1);
      expect(round2(state.openDueEntries[0].principalAmount)).toBe(900);
      expect(state.openDueEntries[0].date).toEqual(new Date('2026-02-01T00:00:00.000Z'));
    });

    it('Case 5 & 6: Full payment and Overpayment transitions excess to Advance', () => {
      // Jan 1: purchase 1000
      // Feb 1: total owed = 1020. Payment of 1500 -> 1020 settles, 480 becomes Advance
      const events: TransactionEvent[] = [
        {
          id: 'p1',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
        {
          id: 'pay1',
          type: 'CREDIT',
          date: new Date('2026-02-01T00:00:00.000Z'),
          amount: new Decimal(1500),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(state.openDueEntries).toHaveLength(0);
      expect(round2(state.advance)).toBe(480);

      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-02-01T00:00:00.000Z'),
        rateSchedule,
      );
      expect(status.status).toBe('Advance');
      expect(status.advance).toBe(480);
      expect(status.totalDue).toBe(0);
    });

    it('Case 7 & 8: Advance consumption: future purchases absorb Advance without interest', () => {
      // Advance of 480. New purchase of 500 on Feb 15.
      // 480 is consumed, leaving a new due entry of 20 on Feb 15.
      const events: TransactionEvent[] = [
        {
          id: 'c1',
          type: 'CREDIT',
          date: new Date('2026-02-01T00:00:00.000Z'),
          amount: new Decimal(480),
        },
        {
          id: 'd1',
          type: 'DEBIT',
          date: new Date('2026-02-15T00:00:00.000Z'),
          amount: new Decimal(500),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(round2(state.advance)).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(round2(state.openDueEntries[0].principalAmount)).toBe(20);
      expect(state.openDueEntries[0].date).toEqual(new Date('2026-02-15T00:00:00.000Z'));
    });

    it('Case 9, 10, 11, 12: Non-retroactive rate change schedule applies prospectively', () => {
      // Jan 1: purchase 1000 at 1%
      // Feb 1: rate increases to 3%
      // Mar 1: calculation date
      // Independent expected:
      // Jan 1 -> Feb 1 (1 month at 1%): 1000 * 0.01 = 10
      // Feb 1 -> Mar 1 (1 month at 3%): 1000 * 0.03 = 30
      // Total interest: 40
      const schedule: RateChange[] = [
        { effectiveDate: new Date('2026-01-01T00:00:00.000Z'), monthlyRatePercent: new Decimal(1) },
        { effectiveDate: new Date('2026-02-01T00:00:00.000Z'), monthlyRatePercent: new Decimal(3) },
      ];

      const res = computeEntryInterest(
        new Decimal(1000),
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-03-01T00:00:00.000Z'),
        schedule,
      );

      expect(round2(res.interest)).toBe(40);
      expect(round2(new Decimal(1000).plus(res.interest))).toBe(1040);
    });

    it('Case 13 & 14: Leap-year & Month-end boundary clamping (2024 leap vs 2025 non-leap)', () => {
      // 2024 leap year: Jan 31 -> Feb 29 = 1 month
      const monthsLeap = computeMonthsElapsed(
        new Date('2024-01-31T00:00:00.000Z'),
        new Date('2024-02-29T00:00:00.000Z'),
      );
      expect(round2(monthsLeap)).toBe(1);

      // 2025 non-leap: Jan 31 -> Feb 28 = 1 month
      const monthsNonLeap = computeMonthsElapsed(
        new Date('2025-01-31T00:00:00.000Z'),
        new Date('2025-02-28T00:00:00.000Z'),
      );
      expect(round2(monthsNonLeap)).toBe(1);
    });

    it('Case 15: Same-day CREDIT + DEBIT prioritizes CREDIT first', () => {
      // Same day (Jan 1): Payment 500, then Purchase 1000.
      // Payment creates 500 Advance. Purchase absorbs 500 Advance, leaving 500 Due.
      const events: TransactionEvent[] = [
        {
          id: 'deb',
          type: 'DEBIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(1000),
        },
        {
          id: 'cred',
          type: 'CREDIT',
          date: new Date('2026-01-01T00:00:00.000Z'),
          amount: new Decimal(500),
        },
      ];
      const state = replayTransactions(events, rateSchedule);
      expect(round2(state.advance)).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(round2(state.openDueEntries[0].principalAmount)).toBe(500);
    });

    it('Case 16: Long-running Due across years accrues monotonically without overflow', () => {
      // Jan 1 2023 to Jan 1 2026 = 36 months at 1%
      // 10000 * 0.01 * 36 = 3600
      const events: TransactionEvent[] = [
        {
          id: 'long',
          type: 'DEBIT',
          date: new Date('2023-01-01T00:00:00.000Z'),
          amount: new Decimal(10000),
        },
      ];
      const schedule: RateChange[] = [
        { effectiveDate: new Date(0), monthlyRatePercent: new Decimal(1) },
      ];
      const state = replayTransactions(events, schedule);
      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-01-01T00:00:00.000Z'),
        schedule,
      );
      expect(status.status).toBe('Due');
      expect(round2(status.totalPrincipal)).toBe(10000);
      expect(round2(status.totalInterest)).toBe(3600);
      expect(round2(status.displayAmount)).toBe(13600);
    });
  });
});
