import { Decimal } from 'decimal.js';
import {
  computeMonthsElapsed,
  computeEntryInterest,
  computeSettlement,
  processPurchase,
  processPayment,
  getBalanceStatus,
  replayTransactions,
  roundCurrency,
  DueAdvanceEngine,
  ChronologyError,
  InvalidDateOrderError,
  InvalidAmountError,
  DueEntry,
  TransactionEvent,
} from '../utils/dueAdvanceEngine';

describe('Due/Advance Engine - Advanced Edge Cases', () => {
  describe('1. Date & Time Zone Traps', () => {
    it('handles Leap Year month-end clamping (Feb 29 -> Feb 28 next year)', () => {
      // Setup: Start on Feb 29, 2024 (Leap Year). End on Feb 28, 2025.
      // Expectation: computeMonthsElapsed should return exactly 12 months, not a fraction.
      const startDate = new Date('2024-02-29T00:00:00Z');
      const endDate = new Date('2025-02-28T00:00:00Z');

      const months = computeMonthsElapsed(startDate, endDate);

      expect(months.toNumber()).toBe(12);
      expect(months.toFixed(2)).toBe('12.00');
    });

    it('normalizes timestamps to start-of-day UTC to prevent DST fractional days', () => {
      // Setup: Cross a Daylight Saving Time boundary (e.g., March 10, 2024 in the US).
      // Use timestamps like '2024-03-01T23:59:59Z' and '2024-04-01T00:00:01Z'.
      // Expectation: The engine should strip the time portion and calculate exactly 1 month.
      const startDate = new Date('2024-03-01T23:59:59Z');
      const endDate = new Date('2024-04-01T00:00:01Z');

      const months = computeMonthsElapsed(startDate, endDate);

      expect(months.toNumber()).toBe(1);
      expect(months.toFixed(2)).toBe('1.00');
    });
  });

  describe('2. Floating-Point & Precision (The 1-Cent Leak)', () => {
    it('prevents floating-point drift on micro-transactions', () => {
      // Setup: 2% monthly rate.
      // Create a scenario where math results in `0.1` + `0.2`.
      // Expectation: Total interest/balance should strictly round to 2 decimal places (e.g., 0.30, NOT 0.30000000000000004).
      const rate = new Decimal(2);
      const startDate = new Date('2026-01-01T00:00:00Z');
      const endDate = new Date('2026-02-01T00:00:00Z'); // exactly 1 month

      // Entry 1: 5 principal at 2% for 1 month = 0.10
      // Entry 2: 10 principal at 2% for 1 month = 0.20
      const { interest: int1 } = computeEntryInterest(new Decimal(5), startDate, endDate, rate);
      const { interest: int2 } = computeEntryInterest(new Decimal(10), startDate, endDate, rate);

      expect(int1.toNumber()).toBe(0.1);
      expect(int2.toNumber()).toBe(0.2);

      const totalInterest = int1.plus(int2);

      // In native JS float: 0.1 + 0.2 === 0.30000000000000004
      expect(totalInterest.toNumber()).toBe(0.3);
      expect(totalInterest.toFixed(2)).toBe('0.30');
      expect(totalInterest.toString()).not.toContain('0.30000000000000004');

      // Verify balance status with multiple micro-entries
      const entries: DueEntry[] = [
        {
          date: startDate,
          principalAmount: new Decimal(5),
          originTransactionId: 't1',
          originPaymentId: null,
        },
        {
          date: startDate,
          principalAmount: new Decimal(10),
          originTransactionId: 't2',
          originPaymentId: null,
        },
      ];
      const status = getBalanceStatus(new Decimal(0), entries, endDate, rate);

      expect(status.totalPrincipal.toNumber()).toBe(15.0);
      expect(status.totalInterest.toFixed(2)).toBe('0.30');
      expect(status.displayAmount.toFixed(2)).toBe('15.30');
      expect(status.displayAmount.toString()).not.toContain('15.300000000000002');
    });

    it('applies consistent half-cent rounding (Bankers rounding or Round-Half-Up)', () => {
      // Setup: Principal and rate that results in exactly ₹12.455 interest.
      // Expectation: Assert that the engine consistently rounds this to ₹12.46.
      const rate = new Decimal(2); // 2% per month
      // 622.75 * 0.02 * 1 = 12.455
      const principal = new Decimal('622.75');
      const startDate = new Date('2026-01-01T00:00:00Z');
      const endDate = new Date('2026-02-01T00:00:00Z');

      const { interest } = computeEntryInterest(principal, startDate, endDate, rate);

      expect(interest.toNumber()).toBe(12.46);
      expect(interest.toFixed(2)).toBe('12.46');
      expect(roundCurrency(new Decimal('12.455')).toNumber()).toBe(12.46);
    });
  });

  describe('3. Transaction Sequencing & Chronology', () => {
    it('processes same-day transactions deterministically (Payment applied before Purchase)', () => {
      // Setup: Pass an array of transactions on the SAME date (e.g., May 1).
      // Index 0: Purchase of 1000
      // Index 1: Payment of 1000
      // Expectation: Regardless of array order, they cancel out on the same day.
      // Zero interest is accrued, and the end state is Settled.
      const sameDate = new Date('2026-05-01T00:00:00Z');
      const rate = new Decimal(2);

      // Order 1: Purchase at index 0, Payment at index 1
      const order1: TransactionEvent[] = [
        { id: 'tx-purchase', type: 'DEBIT', date: sameDate, amount: new Decimal(1000) },
        { id: 'tx-payment', type: 'CREDIT', date: sameDate, amount: new Decimal(1000) },
      ];

      // Order 2: Payment at index 0, Purchase at index 1
      const order2: TransactionEvent[] = [
        { id: 'tx-payment', type: 'CREDIT', date: sameDate, amount: new Decimal(1000) },
        { id: 'tx-purchase', type: 'DEBIT', date: sameDate, amount: new Decimal(1000) },
      ];

      const state1 = replayTransactions(order1, rate);
      const state2 = replayTransactions(order2, rate);

      // Both orders must result in exactly 0 advance, 0 open entries, 0 interest
      expect(state1.advance.toNumber()).toBe(0);
      expect(state1.openDueEntries).toHaveLength(0);

      expect(state2.advance.toNumber()).toBe(0);
      expect(state2.openDueEntries).toHaveLength(0);

      const status1 = getBalanceStatus(state1.advance, state1.openDueEntries, sameDate, rate);
      const status2 = getBalanceStatus(state2.advance, state2.openDueEntries, sameDate, rate);

      expect(status1.status).toBe('Settled');
      expect(status2.status).toBe('Settled');
      expect(status1.displayAmount.toNumber()).toBe(0);
      expect(status2.displayAmount.toNumber()).toBe(0);
      expect(status1.totalInterest.toNumber()).toBe(0);
      expect(status2.totalInterest.toNumber()).toBe(0);
    });

    it('throws an error if transactions are processed out of chronological order', () => {
      // Setup: Process a transaction on May 1, then try to process one on March 15.
      // Expectation: The engine should throw a `ChronologyError` or `InvalidDateOrderError`.
      const engine = new DueAdvanceEngine(2);

      // Step 1: Process purchase on May 1
      engine.processPurchase(1000, new Date('2026-05-01T00:00:00Z'), 'tx-may-1');

      // Step 2: Try to process an earlier transaction on March 15
      expect(() => {
        engine.processPurchase(500, new Date('2026-03-15T00:00:00Z'), 'tx-mar-15');
      }).toThrow(ChronologyError);

      expect(() => {
        engine.processPayment(500, new Date('2026-03-15T00:00:00Z'), 'pay-mar-15');
      }).toThrow(InvalidDateOrderError);

      // Verify standalone functions also guard against chronological violations
      expect(() => {
        processPurchase(
          new Decimal(0),
          new Decimal(500),
          new Date('2026-03-15T00:00:00Z'),
          'tx3',
          new Date('2026-05-01T00:00:00Z'),
        );
      }).toThrow(ChronologyError);

      expect(() => {
        computeSettlement(
          [
            {
              date: new Date('2026-05-01T00:00:00Z'),
              principalAmount: new Decimal(1000),
              originTransactionId: 'tx1',
              originPaymentId: null,
            },
          ],
          new Decimal(500),
          new Date('2026-03-15T00:00:00Z'), // Payment date before due entry date
          new Decimal(2),
        );
      }).toThrow(ChronologyError);
    });
  });

  describe('4. Bizarre Financial Inputs', () => {
    it('throws an error on negative purchase amounts', () => {
      // Setup: call processPurchase(-500)
      // Expectation: Throws an Error (e.g., "Amount must be greater than zero").
      expect(() => {
        processPurchase(new Decimal(0), new Decimal(-500), new Date('2026-01-01T00:00:00Z'), 'tx1');
      }).toThrow(/greater than zero/i);

      expect(() => {
        processPurchase(new Decimal(0), -500, new Date('2026-01-01T00:00:00Z'), 'tx1');
      }).toThrow(InvalidAmountError);

      const engine = new DueAdvanceEngine(2);
      expect(() => {
        engine.processPurchase(-500, new Date('2026-01-01T00:00:00Z'));
      }).toThrow(Error);
    });

    it('throws an error on negative payment amounts', () => {
      // Setup: call processPayment(-500)
      // Expectation: Throws an Error.
      expect(() => {
        processPayment(
          new Decimal(0),
          [],
          new Decimal(-500),
          new Date('2026-01-01T00:00:00Z'),
          new Decimal(2),
        );
      }).toThrow(/greater than zero/i);

      expect(() => {
        processPayment(new Decimal(0), [], -500, new Date('2026-01-01T00:00:00Z'), new Decimal(2));
      }).toThrow(InvalidAmountError);

      const engine = new DueAdvanceEngine(2);
      expect(() => {
        engine.processPayment(-500, new Date('2026-01-01T00:00:00Z'));
      }).toThrow(Error);
    });

    it('handles partial payments that cover ONLY partial interest (no principal reduction)', () => {
      // Setup: 1000 principal, 3 months at 2% = 60 interest. Total Due = 1060.
      // Process a payment of exactly 20.
      // Expectation: Due entry principal should remain 1000.
      // Unpaid interest should be 40.
      // Ensure the engine accurately tracks unpaid interest without accidentally reducing principal.
      const startDate = new Date('2026-01-01T00:00:00Z');
      const paymentDate = new Date('2026-04-01T00:00:00Z');
      const rate = new Decimal(2);

      const dueEntries: DueEntry[] = [
        {
          date: startDate,
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-init',
          originPaymentId: null,
        },
      ];

      // Settle with payment of 20
      const settlement = computeSettlement(dueEntries, new Decimal(20), paymentDate, rate);

      expect(settlement.totalPrincipal.toNumber()).toBe(1000);
      expect(settlement.totalInterest.toNumber()).toBe(60);
      expect(settlement.totalOwed.toNumber()).toBe(1060);
      expect(settlement.remainingPayment.toNumber()).toBe(0);

      // Expectation assertions:
      // Due entry principal should remain 1000
      expect(settlement.newConsolidatedEntry).not.toBeNull();
      expect(settlement.newConsolidatedEntry!.principalAmount.toNumber()).toBe(1000);

      // Unpaid interest should be 40
      expect(settlement.newConsolidatedEntry!.unpaidInterest.toNumber()).toBe(40);
      expect(settlement.unpaidInterest.toNumber()).toBe(40);

      // Replay full workflow test
      const events: TransactionEvent[] = [
        { id: 'tx1', type: 'DEBIT', date: startDate, amount: new Decimal(1000) },
        { id: 'tx2', type: 'CREDIT', date: paymentDate, amount: new Decimal(20) },
      ];

      const state = replayTransactions(events, rate);

      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(1000);
      expect(state.openDueEntries[0].unpaidInterest!.toNumber()).toBe(40);
      expect(state.advance.toNumber()).toBe(0);

      // Verify balance status computation accounts for the unpaid interest without principal mutation
      const status = getBalanceStatus(state.advance, state.openDueEntries, paymentDate, rate);
      expect(status.status).toBe('Due');
      expect(status.totalPrincipal.toNumber()).toBe(1000);
      expect(status.totalInterest.toNumber()).toBe(40);
      expect(status.displayAmount.toNumber()).toBe(1040);
    });
  });
});
