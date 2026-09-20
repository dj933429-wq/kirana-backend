import { Decimal } from 'decimal.js';
import {
  computeMonthsElapsed,
  computeEntryInterest,
  computeSettlement,
  processPurchase,
  processPayment,
  getBalanceStatus,
  replayTransactions,
  DueEntry,
  TransactionEvent,
} from '../utils/dueAdvanceEngine';

/** Helper: create a UTC midnight date */
const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

const d = (n: number) => new Decimal(n);

describe('Due/Advance Engine', () => {
  // ==========================================
  // computeMonthsElapsed
  // ==========================================
  describe('computeMonthsElapsed', () => {
    test('exact months: Jan 1 → Apr 1 = 3', () => {
      expect(computeMonthsElapsed(utc(2026, 1, 1), utc(2026, 4, 1)).toNumber()).toBe(3);
    });

    test('exact months: Feb 1 → Apr 1 = 2', () => {
      expect(computeMonthsElapsed(utc(2026, 2, 1), utc(2026, 4, 1)).toNumber()).toBe(2);
    });

    test('exact months: Mar 1 → Apr 1 = 1', () => {
      expect(computeMonthsElapsed(utc(2026, 3, 1), utc(2026, 4, 1)).toNumber()).toBe(1);
    });

    test('exact months: Apr 20 → May 20 = 1', () => {
      expect(computeMonthsElapsed(utc(2026, 4, 20), utc(2026, 5, 20)).toNumber()).toBe(1);
    });

    test('same date = 0', () => {
      expect(computeMonthsElapsed(utc(2026, 1, 1), utc(2026, 1, 1)).toNumber()).toBe(0);
    });

    test('end before start = 0', () => {
      expect(computeMonthsElapsed(utc(2026, 4, 1), utc(2026, 1, 1)).toNumber()).toBe(0);
    });

    test('partial month: Jan 1 → Jan 15 = 14/31', () => {
      const result = computeMonthsElapsed(utc(2026, 1, 1), utc(2026, 1, 15));
      expect(result.toNumber()).toBeCloseTo(14 / 31, 10);
    });

    test('month-end clamping: Jan 31 → Feb 28 (non-leap) = 1', () => {
      expect(computeMonthsElapsed(utc(2026, 1, 31), utc(2026, 2, 28)).toNumber()).toBe(1);
    });

    test('month-end clamping: Jan 31 → Mar 31 = 2', () => {
      expect(computeMonthsElapsed(utc(2026, 1, 31), utc(2026, 3, 31)).toNumber()).toBe(2);
    });

    test('cross-year: Nov 15 → Feb 15 = 3', () => {
      expect(computeMonthsElapsed(utc(2025, 11, 15), utc(2026, 2, 15)).toNumber()).toBe(3);
    });

    test('1 month + partial: Jan 1 → Feb 15 = 1 + 14/28', () => {
      // Feb 2026 has 28 days
      const result = computeMonthsElapsed(utc(2026, 1, 1), utc(2026, 2, 15));
      expect(result.toNumber()).toBeCloseTo(1 + 14 / 28, 10);
    });
  });

  // ==========================================
  // computeEntryInterest
  // ==========================================
  describe('computeEntryInterest', () => {
    const rate = d(2); // 2% per month

    test('1000 for 3 months at 2% = 60', () => {
      const { interest } = computeEntryInterest(d(1000), utc(2026, 1, 1), utc(2026, 4, 1), rate);
      expect(interest.toNumber()).toBe(60);
    });

    test('1000 for 2 months at 2% = 40', () => {
      const { interest } = computeEntryInterest(d(1000), utc(2026, 2, 1), utc(2026, 4, 1), rate);
      expect(interest.toNumber()).toBe(40);
    });

    test('1000 for 1 month at 2% = 20', () => {
      const { interest } = computeEntryInterest(d(1000), utc(2026, 3, 1), utc(2026, 4, 1), rate);
      expect(interest.toNumber()).toBe(20);
    });

    test('620 for 1 month at 2% = 12.40', () => {
      const { interest } = computeEntryInterest(d(620), utc(2026, 4, 20), utc(2026, 5, 20), rate);
      expect(interest.toNumber()).toBe(12.4);
    });

    test('zero rate returns 0 interest', () => {
      const { interest } = computeEntryInterest(d(1000), utc(2026, 1, 1), utc(2026, 4, 1), d(0));
      expect(interest.toNumber()).toBe(0);
    });

    test('zero principal returns 0 interest', () => {
      const { interest } = computeEntryInterest(d(0), utc(2026, 1, 1), utc(2026, 4, 1), rate);
      expect(interest.toNumber()).toBe(0);
    });

    test('same start/end date returns 0 interest', () => {
      const { interest } = computeEntryInterest(d(1000), utc(2026, 1, 1), utc(2026, 1, 1), rate);
      expect(interest.toNumber()).toBe(0);
    });
  });

  // ==========================================
  // computeSettlement
  // ==========================================
  describe('computeSettlement', () => {
    const rate = d(2);

    test('settle 3 entries on Apr 1: total interest 120, total owed 3120', () => {
      const entries: DueEntry[] = [
        {
          date: utc(2026, 1, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
        {
          date: utc(2026, 2, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx2',
          originPaymentId: null,
        },
        {
          date: utc(2026, 3, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx3',
          originPaymentId: null,
        },
      ];

      const result = computeSettlement(entries, d(4000), utc(2026, 4, 1), rate);

      expect(result.totalPrincipal.toNumber()).toBe(3000);
      expect(result.totalInterest.toNumber()).toBe(120);
      expect(result.totalOwed.toNumber()).toBe(3120);
      expect(result.remainingPayment.toNumber()).toBe(880);
      expect(result.newConsolidatedEntry).toBeNull();
      expect(result.settledEntries).toHaveLength(3);
      expect(result.settledEntries[0].interestCharged.toNumber()).toBe(60);
      expect(result.settledEntries[1].interestCharged.toNumber()).toBe(40);
      expect(result.settledEntries[2].interestCharged.toNumber()).toBe(20);
    });

    test('partial payment creates consolidated entry', () => {
      const entries: DueEntry[] = [
        {
          date: utc(2026, 1, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
      ];

      // 1 month interest = 20, total owed = 1020, payment = 500
      const result = computeSettlement(entries, d(500), utc(2026, 2, 1), rate);

      expect(result.totalOwed.toNumber()).toBe(1020);
      expect(result.remainingPayment.toNumber()).toBe(0);
      expect(result.newConsolidatedEntry).not.toBeNull();
      expect(result.newConsolidatedEntry!.principalAmount.toNumber()).toBe(520);
      expect(result.newConsolidatedEntry!.date).toEqual(utc(2026, 2, 1));
    });

    test('exact payment: no excess, no shortfall', () => {
      const entries: DueEntry[] = [
        {
          date: utc(2026, 1, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
      ];

      // 1 month interest = 20, total owed = 1020
      const result = computeSettlement(entries, d(1020), utc(2026, 2, 1), rate);

      expect(result.remainingPayment.toNumber()).toBe(0);
      expect(result.newConsolidatedEntry).toBeNull();
    });
  });

  // ==========================================
  // processPurchase
  // ==========================================
  describe('processPurchase', () => {
    test('no advance: full amount becomes due entry', () => {
      const result = processPurchase(d(0), d(1000), utc(2026, 1, 1), 'tx1');
      expect(result.newAdvance.toNumber()).toBe(0);
      expect(result.newDueEntry).not.toBeNull();
      expect(result.newDueEntry!.principalAmount.toNumber()).toBe(1000);
      expect(result.outstandingPrincipal.toNumber()).toBe(1000);
      expect(result.advanceUsed.toNumber()).toBe(0);
    });

    test('advance fully covers purchase: no due entry', () => {
      const result = processPurchase(d(880), d(500), utc(2026, 4, 15), 'tx5');
      expect(result.newAdvance.toNumber()).toBe(380);
      expect(result.newDueEntry).toBeNull();
      expect(result.outstandingPrincipal.toNumber()).toBe(0);
      expect(result.advanceUsed.toNumber()).toBe(500);
    });

    test('advance partially covers purchase: shortfall due entry', () => {
      const result = processPurchase(d(380), d(1000), utc(2026, 4, 20), 'tx6');
      expect(result.newAdvance.toNumber()).toBe(0);
      expect(result.newDueEntry).not.toBeNull();
      expect(result.newDueEntry!.principalAmount.toNumber()).toBe(620);
      expect(result.outstandingPrincipal.toNumber()).toBe(620);
      expect(result.advanceUsed.toNumber()).toBe(380);
    });
  });

  // ==========================================
  // processPayment
  // ==========================================
  describe('processPayment', () => {
    const rate = d(2);

    test('no due entries: full amount goes to advance', () => {
      const result = processPayment(d(0), [], d(4000), utc(2026, 4, 1), rate);
      expect(result.newAdvance.toNumber()).toBe(4000);
      expect(result.settlement).toBeNull();
    });

    test('payment settles entries with excess to advance', () => {
      const entries: DueEntry[] = [
        {
          date: utc(2026, 4, 20),
          principalAmount: d(620),
          originTransactionId: 'tx6',
          originPaymentId: null,
        },
      ];
      const result = processPayment(d(0), entries, d(1000), utc(2026, 5, 20), rate);
      expect(result.newAdvance.toNumber()).toBe(367.6);
      expect(result.settlement).not.toBeNull();
      expect(result.settlement!.totalInterest.toNumber()).toBe(12.4);
    });
  });

  // ==========================================
  // getBalanceStatus
  // ==========================================
  describe('getBalanceStatus', () => {
    const rate = d(2);

    test('due entries → Due status with interest', () => {
      const entries: DueEntry[] = [
        {
          date: utc(2026, 1, 1),
          principalAmount: d(1000),
          originTransactionId: 'tx1',
          originPaymentId: null,
        },
      ];
      const status = getBalanceStatus(d(0), entries, utc(2026, 2, 1), rate);
      expect(status.status).toBe('Due');
      // 1 month interest = 20, display = 1020
      expect(status.displayAmount.toNumber()).toBe(1020);
      expect(status.totalPrincipal.toNumber()).toBe(1000);
      expect(status.totalInterest.toNumber()).toBe(20);
    });

    test('no entries, advance > 0 → Advance status', () => {
      const status = getBalanceStatus(d(880), [], utc(2026, 4, 1), rate);
      expect(status.status).toBe('Advance');
      expect(status.displayAmount.toNumber()).toBe(880);
    });

    test('no entries, no advance → Settled status', () => {
      const status = getBalanceStatus(d(0), [], utc(2026, 4, 1), rate);
      expect(status.status).toBe('Settled');
      expect(status.displayAmount.toNumber()).toBe(0);
    });
  });

  // ==========================================
  // Full Worked Example — Step by Step
  // ==========================================
  describe('Full Worked Example (2% monthly rate)', () => {
    const rate = d(2);

    // All 8 events
    const allEvents: TransactionEvent[] = [
      { id: 'tx1', type: 'DEBIT', date: utc(2026, 1, 1), amount: d(1000) },
      { id: 'tx2', type: 'DEBIT', date: utc(2026, 2, 1), amount: d(1000) },
      { id: 'tx3', type: 'DEBIT', date: utc(2026, 3, 1), amount: d(1000) },
      { id: 'tx4', type: 'CREDIT', date: utc(2026, 4, 1), amount: d(4000) },
      { id: 'tx5', type: 'DEBIT', date: utc(2026, 4, 15), amount: d(500) },
      { id: 'tx6', type: 'DEBIT', date: utc(2026, 4, 20), amount: d(1000) },
      { id: 'tx7', type: 'CREDIT', date: utc(2026, 5, 20), amount: d(1000) },
      { id: 'tx8', type: 'DEBIT', date: utc(2026, 6, 1), amount: d(500) },
    ];

    test('Step 1: Jan 1 purchase ₹1,000 → Due ₹1,000', () => {
      const state = replayTransactions(allEvents.slice(0, 1), rate);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(1000);
      expect(state.openDueEntries[0].originTransactionId).toBe('tx1');
    });

    test('Step 2: Feb 1 purchase ₹1,000 → Due ₹2,000 (two entries)', () => {
      const state = replayTransactions(allEvents.slice(0, 2), rate);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(2);

      const principalSum = state.openDueEntries.reduce(
        (sum, e) => sum.plus(e.principalAmount),
        d(0),
      );
      expect(principalSum.toNumber()).toBe(2000);
    });

    test('Step 3: Mar 1 purchase ₹1,000 → Due ₹3,000 (three entries)', () => {
      const state = replayTransactions(allEvents.slice(0, 3), rate);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(3);

      const principalSum = state.openDueEntries.reduce(
        (sum, e) => sum.plus(e.principalAmount),
        d(0),
      );
      expect(principalSum.toNumber()).toBe(3000);
    });

    test('Step 4: Apr 1 payment ₹4,000 → interest ₹120, Advance ₹880', () => {
      const state = replayTransactions(allEvents.slice(0, 4), rate);

      // All entries settled
      expect(state.openDueEntries).toHaveLength(0);
      expect(state.advance.toNumber()).toBe(880);

      // 3 entries settled by tx4
      const tx4Settlements = state.settledHistory.filter((s) => s.settledByPaymentId === 'tx4');
      expect(tx4Settlements).toHaveLength(3);

      // Individual interest amounts
      const tx1Settlement = tx4Settlements.find((s) => s.entryOriginTransactionId === 'tx1')!;
      expect(tx1Settlement.interestCharged.toNumber()).toBe(60); // 3 months

      const tx2Settlement = tx4Settlements.find((s) => s.entryOriginTransactionId === 'tx2')!;
      expect(tx2Settlement.interestCharged.toNumber()).toBe(40); // 2 months

      const tx3Settlement = tx4Settlements.find((s) => s.entryOriginTransactionId === 'tx3')!;
      expect(tx3Settlement.interestCharged.toNumber()).toBe(20); // 1 month

      // Total interest
      const totalInterest = tx4Settlements.reduce((sum, s) => sum.plus(s.interestCharged), d(0));
      expect(totalInterest.toNumber()).toBe(120);
    });

    test('Step 5: Apr 15 purchase ₹500 → Advance ₹380', () => {
      const state = replayTransactions(allEvents.slice(0, 5), rate);

      expect(state.openDueEntries).toHaveLength(0);
      expect(state.advance.toNumber()).toBe(380);

      // Advance usage: tx5 fully covered by advance
      const tx5Usage = state.advanceUsageByTransaction.get('tx5')!;
      expect(tx5Usage.advanceUsed.toNumber()).toBe(500);
      expect(tx5Usage.outstandingPrincipal.toNumber()).toBe(0);
    });

    test('Step 6: Apr 20 purchase ₹1,000 → Due ₹620 (new entry)', () => {
      const state = replayTransactions(allEvents.slice(0, 6), rate);

      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(620);
      expect(state.openDueEntries[0].originTransactionId).toBe('tx6');

      // Advance usage: tx6 partially covered
      const tx6Usage = state.advanceUsageByTransaction.get('tx6')!;
      expect(tx6Usage.advanceUsed.toNumber()).toBe(380);
      expect(tx6Usage.outstandingPrincipal.toNumber()).toBe(620);
    });

    test('Step 7: May 20 payment ₹1,000 → interest ₹12.40, Advance ₹367.60', () => {
      const state = replayTransactions(allEvents.slice(0, 7), rate);

      expect(state.openDueEntries).toHaveLength(0);
      expect(state.advance.toNumber()).toBe(367.6);

      // tx7 settled 1 entry (the 620 due)
      const tx7Settlements = state.settledHistory.filter((s) => s.settledByPaymentId === 'tx7');
      expect(tx7Settlements).toHaveLength(1);
      expect(tx7Settlements[0].entryPrincipal.toNumber()).toBe(620);
      expect(tx7Settlements[0].interestCharged.toNumber()).toBe(12.4);
    });

    test('Step 8: Jun 1 purchase ₹500 → Due ₹132.40 (new entry)', () => {
      const state = replayTransactions(allEvents, rate);

      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(132.4);
      expect(state.openDueEntries[0].originTransactionId).toBe('tx8');

      // Advance usage
      const tx8Usage = state.advanceUsageByTransaction.get('tx8')!;
      expect(tx8Usage.advanceUsed.toNumber()).toBe(367.6);
      expect(tx8Usage.outstandingPrincipal.toNumber()).toBe(132.4);
    });

    test('Full replay: complete settlement history', () => {
      const state = replayTransactions(allEvents, rate);

      // 4 total settlements (3 from tx4 + 1 from tx7)
      expect(state.settledHistory).toHaveLength(4);

      // Final state
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(1);
      expect(state.openDueEntries[0].principalAmount.toNumber()).toBe(132.4);
    });
  });

  // ==========================================
  // Edge Cases
  // ==========================================
  describe('Edge Cases', () => {
    test('zero interest rate: payment covers only principal', () => {
      const events: TransactionEvent[] = [
        { id: 'tx1', type: 'DEBIT', date: utc(2026, 1, 1), amount: d(1000) },
        {
          id: 'tx2',
          type: 'CREDIT',
          date: utc(2026, 4, 1),
          amount: d(1000),
        },
      ];
      const state = replayTransactions(events, d(0));
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(0);

      // No interest charged
      expect(state.settledHistory[0].interestCharged.toNumber()).toBe(0);
    });

    test('payment with no prior transactions → all to advance', () => {
      const events: TransactionEvent[] = [
        {
          id: 'tx1',
          type: 'CREDIT',
          date: utc(2026, 1, 1),
          amount: d(5000),
        },
      ];
      const state = replayTransactions(events, d(2));
      expect(state.advance.toNumber()).toBe(5000);
      expect(state.openDueEntries).toHaveLength(0);
      expect(state.settledHistory).toHaveLength(0);
    });

    test('partial payment creates consolidated entry then gets settled', () => {
      const events: TransactionEvent[] = [
        { id: 'tx1', type: 'DEBIT', date: utc(2026, 1, 1), amount: d(1000) },
        // Pay 500 on Feb 1: owed = 1000+20=1020, shortfall=520
        {
          id: 'tx2',
          type: 'CREDIT',
          date: utc(2026, 2, 1),
          amount: d(500),
        },
        // Pay 600 on Mar 1: consolidated {Feb1, 520}, 1 month interest=10.40
        // owed=530.40, payment=600, excess=69.60
        {
          id: 'tx3',
          type: 'CREDIT',
          date: utc(2026, 3, 1),
          amount: d(600),
        },
      ];
      const state = replayTransactions(events, d(2));

      // After tx2: consolidated entry {Feb1, 520}
      // After tx3: settle {Feb1, 520}, interest = 520*0.02*1=10.40, owed=530.40
      // excess = 600-530.40 = 69.60
      expect(state.advance.toNumber()).toBe(69.6);
      expect(state.openDueEntries).toHaveLength(0);

      // Settlement history: tx2 settled tx1, tx3 settled consolidated
      expect(state.settledHistory).toHaveLength(2);

      const tx3Settlement = state.settledHistory.find((s) => s.settledByPaymentId === 'tx3')!;
      expect(tx3Settlement.entryPrincipal.toNumber()).toBe(520);
      expect(tx3Settlement.interestCharged.toNumber()).toBe(10.4);
      expect(tx3Settlement.entryOriginTransactionId).toBeNull(); // system-generated
      expect(tx3Settlement.entryOriginPaymentId).toBe('tx2'); // created by tx2
    });

    test('multiple purchases fully covered by advance', () => {
      const events: TransactionEvent[] = [
        // Big payment first → all to advance
        {
          id: 'tx1',
          type: 'CREDIT',
          date: utc(2026, 1, 1),
          amount: d(10000),
        },
        { id: 'tx2', type: 'DEBIT', date: utc(2026, 2, 1), amount: d(1000) },
        { id: 'tx3', type: 'DEBIT', date: utc(2026, 3, 1), amount: d(2000) },
        { id: 'tx4', type: 'DEBIT', date: utc(2026, 4, 1), amount: d(3000) },
      ];
      const state = replayTransactions(events, d(2));

      expect(state.advance.toNumber()).toBe(4000); // 10000 - 1000 - 2000 - 3000
      expect(state.openDueEntries).toHaveLength(0);
      expect(state.settledHistory).toHaveLength(0);

      // All purchases fully covered
      expect(state.advanceUsageByTransaction.get('tx2')!.outstandingPrincipal.toNumber()).toBe(0);
      expect(state.advanceUsageByTransaction.get('tx3')!.outstandingPrincipal.toNumber()).toBe(0);
      expect(state.advanceUsageByTransaction.get('tx4')!.outstandingPrincipal.toNumber()).toBe(0);
    });
  });
});
