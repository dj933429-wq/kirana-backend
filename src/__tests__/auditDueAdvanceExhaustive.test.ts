import Decimal from 'decimal.js';
import {
  processPurchase,
  processPayment,
  computeEntryInterest,
  replayTransactions,
  getBalanceStatus,
  normalizeToUTCMidnight,
  TransactionEvent,
  InvalidAmountError,
  InvalidDateOrderError,
  roundCurrency,
} from '../utils/dueAdvanceEngine';

describe('Audit: Due/Advance Exhaustive Payment Matrix & Engine Invariants (Categories G, H, I, J, K, L, M, N, O, AI, AJ)', () => {
  const MONTHLY_RATE = new Decimal(2); // 2% per month

  describe('Phase 3.H: Exhaustive 24-Step Payment Test Matrix', () => {
    // TEST 1 — No due, payment received
    it('TEST 1: No due, payment received -> entire amount becomes Advance', () => {
      const res = processPayment(new Decimal(0), [], 1000, new Date('2026-01-01'), MONTHLY_RATE);
      expect(res.newAdvance.toNumber()).toBe(1000);
      expect(res.settlement).toBeNull();
      expect(res.principalSettled).toBe(0);
      expect(res.interestSettled).toBe(0);
    });

    // TEST 2 — Payment smaller than accrued interest
    // principal 1000, 3 months elapsed (Jan 1 to Apr 1) => interest = 60, payment = 20
    it('TEST 2: Payment smaller than accrued interest -> interest partially settled, principal untouched, unpaid interest does not compound', () => {
      const dueEntries = [
        {
          date: new Date('2026-01-01T00:00:00Z'),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-1',
          originPaymentId: null,
          unpaidInterest: new Decimal(0),
        },
      ];

      const res = processPayment(
        new Decimal(0),
        dueEntries,
        20,
        new Date('2026-04-01T00:00:00Z'),
        MONTHLY_RATE,
      );

      // Independent Oracle Calculation:
      // Jan 1 to Apr 1 is exactly 3 months: 1000 * 2% * 3 = 60 interest.
      // Payment 20 settles 20 of interest.
      // Unpaid interest remaining = 40.
      // Principal remains 1000.
      expect(res.interestSettled).toBe(20);
      expect(res.principalSettled).toBe(0);
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.settlement).not.toBeNull();
      expect(res.settlement!.newConsolidatedEntry).not.toBeNull();
      expect(res.settlement!.newConsolidatedEntry!.principalAmount.toNumber()).toBe(1000);
      expect(res.settlement!.newConsolidatedEntry!.unpaidInterest.toNumber()).toBe(40);
    });

    // TEST 3 — Payment exactly equal to interest
    it('TEST 3: Payment exactly equal to interest -> all interest settled, principal unchanged, 0 advance', () => {
      const dueEntries = [
        {
          date: new Date('2026-01-01T00:00:00Z'),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-1',
          originPaymentId: null,
        },
      ];

      // 3 months = 60 interest. Payment = 60.
      const res = processPayment(
        new Decimal(0),
        dueEntries,
        60,
        new Date('2026-04-01T00:00:00Z'),
        MONTHLY_RATE,
      );

      expect(res.interestSettled).toBe(60);
      expect(res.principalSettled).toBe(0);
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.settlement!.newConsolidatedEntry!.principalAmount.toNumber()).toBe(1000);
      expect(res.settlement!.newConsolidatedEntry!.unpaidInterest.toNumber()).toBe(0);
    });

    // TEST 4 — Payment greater than interest but less than total due
    it('TEST 4: Payment greater than interest but less than total due -> interest cleared, principal reduced', () => {
      const dueEntries = [
        {
          date: new Date('2026-01-01T00:00:00Z'),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-1',
          originPaymentId: null,
        },
      ];

      // Interest = 60, Total due = 1060. Payment = 500.
      // 60 pays interest, 440 reduces principal to 560.
      const res = processPayment(
        new Decimal(0),
        dueEntries,
        500,
        new Date('2026-04-01T00:00:00Z'),
        MONTHLY_RATE,
      );

      expect(res.interestSettled).toBe(60);
      expect(res.principalSettled).toBe(440);
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.settlement!.newConsolidatedEntry!.principalAmount.toNumber()).toBe(560);
      expect(res.settlement!.newConsolidatedEntry!.unpaidInterest.toNumber()).toBe(0);
    });

    // TEST 5 — Payment exactly equal to interest + principal
    it('TEST 5: Payment exactly equal to interest + principal -> customer fully settled, 0 due, 0 advance', () => {
      const dueEntries = [
        {
          date: new Date('2026-01-01T00:00:00Z'),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-1',
          originPaymentId: null,
        },
      ];

      const res = processPayment(
        new Decimal(0),
        dueEntries,
        1060,
        new Date('2026-04-01T00:00:00Z'),
        MONTHLY_RATE,
      );

      expect(res.interestSettled).toBe(60);
      expect(res.principalSettled).toBe(1000);
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.settlement!.newConsolidatedEntry).toBeNull();
      expect(res.settlement!.settledEntries).toHaveLength(1);
    });

    // TEST 6 — Payment exceeds total due
    it('TEST 6: Payment exceeds total due -> interest and principal settled, excess becomes Advance', () => {
      const dueEntries = [
        {
          date: new Date('2026-01-01T00:00:00Z'),
          principalAmount: new Decimal(1000),
          originTransactionId: 'tx-1',
          originPaymentId: null,
        },
      ];

      // Total due = 1060. Payment = 1500 -> 60 interest, 1000 principal, 440 advance
      const res = processPayment(
        new Decimal(0),
        dueEntries,
        1500,
        new Date('2026-04-01T00:00:00Z'),
        MONTHLY_RATE,
      );

      expect(res.interestSettled).toBe(60);
      expect(res.principalSettled).toBe(1000);
      expect(res.newAdvance.toNumber()).toBe(440);
      expect(res.settlement!.newConsolidatedEntry).toBeNull();
    });

    // TEST 7 — Payment with existing Advance and no Due
    it('TEST 7: Payment with existing Advance and no Due -> increases Advance', () => {
      const res = processPayment(new Decimal(500), [], 250, new Date('2026-01-01'), MONTHLY_RATE);
      expect(res.newAdvance.toNumber()).toBe(750);
      expect(res.settlement).toBeNull();
    });

    // TEST 8 — Purchase using existing Advance
    it('TEST 8: Purchase using existing Advance -> consumes Advance first, excess becomes Due', () => {
      // Advance = 400, Purchase = 600 -> Advance becomes 0, Due entry of 200
      const res = processPurchase(new Decimal(400), 600, new Date('2026-01-01'), 'tx-buy-1');

      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.advanceUsed.toNumber()).toBe(400);
      expect(res.outstandingPrincipal.toNumber()).toBe(200);
      expect(res.newDueEntry).not.toBeNull();
      expect(res.newDueEntry!.principalAmount.toNumber()).toBe(200);
    });

    // TEST 9 — Purchase exactly equal to Advance
    it('TEST 9: Purchase exactly equal to Advance -> Advance becomes 0, no Due entry', () => {
      const res = processPurchase(new Decimal(500), 500, new Date('2026-01-01'), 'tx-buy-2');
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.advanceUsed.toNumber()).toBe(500);
      expect(res.outstandingPrincipal.toNumber()).toBe(0);
      expect(res.newDueEntry).toBeNull();
    });

    // TEST 10 — Purchase less than Advance
    it('TEST 10: Purchase less than Advance -> Advance decreases, no Due entry', () => {
      const res = processPurchase(new Decimal(500), 200, new Date('2026-01-01'), 'tx-buy-3');
      expect(res.newAdvance.toNumber()).toBe(300);
      expect(res.advanceUsed.toNumber()).toBe(200);
      expect(res.outstandingPrincipal.toNumber()).toBe(0);
      expect(res.newDueEntry).toBeNull();
    });

    // TEST 11 — Purchase greater than Advance
    it('TEST 11: Purchase greater than Advance -> Advance zero, remainder becomes Due', () => {
      const res = processPurchase(new Decimal(100), 1000, new Date('2026-01-01'), 'tx-buy-4');
      expect(res.newAdvance.toNumber()).toBe(0);
      expect(res.advanceUsed.toNumber()).toBe(100);
      expect(res.outstandingPrincipal.toNumber()).toBe(900);
      expect(res.newDueEntry!.principalAmount.toNumber()).toBe(900);
    });

    // TEST 16 & 17 — Simple interest on unpaid interest (NO compounding on unpaid interest)
    it('TEST 16 & 17: Partial payment leaves unpaid interest which never compounds into principal', () => {
      const events: TransactionEvent[] = [
        {
          id: '1',
          type: 'DEBIT',
          amount: new Decimal(1000),
          date: new Date('2026-01-01'),
          createdAt: new Date(),
        },
        {
          id: '2',
          type: 'CREDIT',
          amount: new Decimal(20),
          date: new Date('2026-04-01'),
          createdAt: new Date(),
        }, // interest was 60, paid 20 -> 40 unpaid
      ];

      const state = replayTransactions(events, MONTHLY_RATE);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(1000);
      expect(state.openDueEntries[0].unpaidInterest?.toNumber()).toBe(40);

      // Check balance status 1 month later on 2026-05-01
      // Interest for Apr 1 to May 1 (1 month) on principal 1000 = 20.
      // Total interest as of May 1 = 40 (prior unpaid) + 20 (new simple interest) = 60.
      // It must NOT be calculated on 1040 (no compounding)!
      const status = getBalanceStatus(
        state.advance,
        state.openDueEntries,
        new Date('2026-05-01'),
        MONTHLY_RATE,
      );
      expect(status.totalPrincipal.toNumber()).toBe(1000);
      expect(status.totalInterest.toNumber()).toBe(60); // 40 + 20
      expect(status.displayAmount.toNumber()).toBe(1060);
    });

    // TEST 21 — Invariant: Due and Advance should never both represent the same money incorrectly
    it('TEST 21: Balance status is mutually exclusive (either Due or Advance or Settled)', () => {
      const dueStatus = getBalanceStatus(
        new Decimal(0),
        [
          {
            date: new Date('2026-01-01'),
            principalAmount: new Decimal(500),
            originTransactionId: '1',
            originPaymentId: null,
          },
        ],
        new Date('2026-01-01'),
        MONTHLY_RATE,
      );
      expect(dueStatus.status).toBe('Due');
      expect(dueStatus.advance).toBe(0);
      expect(dueStatus.totalPrincipal.toNumber()).toBe(500);

      const advStatus = getBalanceStatus(
        new Decimal(500),
        [],
        new Date('2026-01-01'),
        MONTHLY_RATE,
      );
      expect(advStatus.status).toBe('Advance');
      expect(advStatus.totalDue).toBe(0);
      expect(advStatus.totalPrincipal.toNumber()).toBe(0);
      expect(advStatus.advance).toBe(500);

      const settledStatus = getBalanceStatus(
        new Decimal(0),
        [],
        new Date('2026-01-01'),
        MONTHLY_RATE,
      );
      expect(settledStatus.status).toBe('Settled');
      expect(settledStatus.totalDue).toBe(0);
      expect(settledStatus.advance).toBe(0);
    });

    // TEST 24 — Same-day deterministic ordering: CREDIT before DEBIT
    it('TEST 24: Same-day transaction ordering strictly processes CREDIT before DEBIT', () => {
      const sameDate = new Date('2026-03-01T00:00:00Z');
      // Even if DEBIT appears first in the array, engine must sort CREDIT first on the same date!
      const events: TransactionEvent[] = [
        {
          id: 'tx-debit',
          type: 'DEBIT',
          amount: new Decimal(500),
          date: sameDate,
          createdAt: new Date('2026-03-01T10:00:00Z'),
        },
        {
          id: 'tx-credit',
          type: 'CREDIT',
          amount: new Decimal(500),
          date: sameDate,
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
      ];

      const state = replayTransactions(events, MONTHLY_RATE);
      // If CREDIT processed before DEBIT:
      // CREDIT (500) -> Advance = 500
      // DEBIT (500) -> consumes Advance 500 -> Advance = 0, Due = 0!
      // Customer is fully settled with 0 due and 0 advance!
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(0);
    });
  });

  describe('Phase 3.I: ABC Traders Reference Scenario (Full Verification)', () => {
    it('should assert each exact intermediate ledger state of the ABC Traders scenario', () => {
      const events: TransactionEvent[] = [
        // Jan 1: Buy 1000
        {
          id: '1',
          type: 'DEBIT',
          amount: new Decimal(1000),
          date: new Date('2026-01-01T00:00:00Z'),
          createdAt: new Date(),
        },
        // Feb 1: Buy 1000
        {
          id: '2',
          type: 'DEBIT',
          amount: new Decimal(1000),
          date: new Date('2026-02-01T00:00:00Z'),
          createdAt: new Date(),
        },
        // Mar 1: Buy 1000
        {
          id: '3',
          type: 'DEBIT',
          amount: new Decimal(1000),
          date: new Date('2026-03-01T00:00:00Z'),
          createdAt: new Date(),
        },
      ];

      // Replay up to Apr 1 payment: Pay 4000
      // Interest on Jan 1 buy (3 mos @ 2%) = 60
      // Interest on Feb 1 buy (2 mos @ 2%) = 40
      // Interest on Mar 1 buy (1 mo @ 2%) = 20
      // Total accrued interest = 120
      // Principal = 3000
      // Total due = 3120
      // Payment 4000 -> 120 interest settled + 3000 principal settled = 3120
      // Advance = 4000 - 3120 = 880
      events.push({
        id: '4',
        type: 'CREDIT',
        amount: new Decimal(4000),
        date: new Date('2026-04-01T00:00:00Z'),
        createdAt: new Date(),
      });
      let state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(880);
      expect(state.openDueEntries).toHaveLength(0);

      // Apr 15: Buy 500
      // Consumes 500 from Advance (880 - 500 = 380 Advance remaining)
      events.push({
        id: '5',
        type: 'DEBIT',
        amount: new Decimal(500),
        date: new Date('2026-04-15T00:00:00Z'),
        createdAt: new Date(),
      });
      state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(380);
      expect(state.openDueEntries).toHaveLength(0);

      // Apr 20: Buy 1000
      // Consumes 380 Advance, remaining 620 becomes Due on Apr 20
      events.push({
        id: '6',
        type: 'DEBIT',
        amount: new Decimal(1000),
        date: new Date('2026-04-20T00:00:00Z'),
        createdAt: new Date(),
      });
      state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(620);
      expect(state.openDueEntries[0].date.toISOString().slice(0, 10)).toBe('2026-04-20');

      // May 20: Pay 1000
      // Elapsed Apr 20 to May 20 = exactly 1 month
      // Interest on 620 @ 2% = 12.40
      // Total due = 632.40
      // Payment 1000 settles 12.40 interest + 620 principal = 632.40
      // Advance = 1000 - 632.40 = 367.60
      events.push({
        id: '7',
        type: 'CREDIT',
        amount: new Decimal(1000),
        date: new Date('2026-05-20T00:00:00Z'),
        createdAt: new Date(),
      });
      state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(367.6);
      expect(state.openDueEntries).toHaveLength(0);

      // Jun 1: Buy 500
      // Consumes 367.60 from Advance
      // Remaining Due = 500 - 367.60 = 132.40
      events.push({
        id: '8',
        type: 'DEBIT',
        amount: new Decimal(500),
        date: new Date('2026-06-01T00:00:00Z'),
        createdAt: new Date(),
      });
      state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(132.4);
    });
  });

  describe('Phase 3.J & K: Interest Date Boundaries, Leap Years & Precision', () => {
    it('should compute exact interest for February in non-leap year (2025: 28 days)', () => {
      const { interest } = computeEntryInterest(
        new Decimal(1000),
        new Date('2025-02-01T00:00:00Z'),
        new Date('2025-03-01T00:00:00Z'),
        MONTHLY_RATE,
      );
      // Feb 1 to Mar 1 is 1 calendar month = 20
      expect(interest.toNumber()).toBe(20);
    });

    it('should compute exact interest for February in leap year (2024: 29 days)', () => {
      const { interest } = computeEntryInterest(
        new Decimal(1000),
        new Date('2024-02-01T00:00:00Z'),
        new Date('2024-03-01T00:00:00Z'),
        MONTHLY_RATE,
      );
      // Feb 1 to Mar 1 in leap year is 1 calendar month = 20
      expect(interest.toNumber()).toBe(20);
    });

    it('should perform ROUND_HALF_UP rounding on half-cent interest calculations', () => {
      // Principal 125, 1 month @ 2% = 2.50
      expect(roundCurrency(2.505).toNumber()).toBe(2.51);
      expect(roundCurrency(2.504).toNumber()).toBe(2.5);
      expect(roundCurrency(0.005).toNumber()).toBe(0.01);
    });

    it('should normalize varying timezone offsets to UTC midnight', () => {
      const d1 = new Date('2026-05-15T05:30:00+05:30');
      const norm = normalizeToUTCMidnight(d1);
      expect(norm.getUTCHours()).toBe(0);
      expect(norm.getUTCMinutes()).toBe(0);
      expect(norm.getUTCSeconds()).toBe(0);
      expect(norm.getUTCMilliseconds()).toBe(0);
    });
  });

  describe('Phase 3.L & M: Chronology and Invalid Amounts Enforcement', () => {
    it('should throw InvalidAmountError on payment <= 0', () => {
      expect(() =>
        processPayment(new Decimal(0), [], 0, new Date('2026-01-01'), MONTHLY_RATE),
      ).toThrow(InvalidAmountError);

      expect(() =>
        processPayment(new Decimal(0), [], -100, new Date('2026-01-01'), MONTHLY_RATE),
      ).toThrow(InvalidAmountError);
    });

    it('should throw InvalidAmountError on purchase <= 0', () => {
      expect(() => processPurchase(new Decimal(0), 0, new Date('2026-01-01'), 'tx-1')).toThrow(
        InvalidAmountError,
      );

      expect(() => processPurchase(new Decimal(0), -50, new Date('2026-01-01'), 'tx-1')).toThrow(
        InvalidAmountError,
      );
    });

    it('should throw InvalidDateOrderError when payment date precedes last processed date', () => {
      expect(() =>
        processPayment(
          new Decimal(0),
          [],
          100,
          new Date('2026-01-01'),
          MONTHLY_RATE,
          new Date('2026-02-01'), // last processed date is in the future
        ),
      ).toThrow(InvalidDateOrderError);
    });
  });
});
