import { Decimal } from 'decimal.js';
import {
  replayTransactions,
  getBalanceStatus,
  computeEntryInterest,
  TransactionEvent,
} from '../utils/dueAdvanceEngine';

describe('Unpaid Interest Display Consistency Regression Test', () => {
  it('verifies summary and openEntries remain consistent when unpaid interest exists after underpayment', () => {
    // 1. Transaction 1: DEBIT ₹10,000 on 2025-01-01
    // 2. Rate: 1% monthly
    // 3. Transaction 2: CREDIT ₹40 on 2025-02-01 (1 month elapsed, ₹100 interest accrued, ₹40 pays partial interest)
    // 4. As-of: 2025-02-01
    const events: TransactionEvent[] = [
      {
        id: 'tx-debit-1',
        type: 'DEBIT',
        date: new Date('2025-01-01T00:00:00.000Z'),
        amount: new Decimal(10000),
      },
      {
        id: 'tx-credit-1',
        type: 'CREDIT',
        date: new Date('2025-02-01T00:00:00.000Z'),
        amount: new Decimal(40),
      },
    ];

    const rateSchedule = 1; // 1% monthly
    const asOfDate = new Date('2025-02-01T00:00:00.000Z');

    const state = replayTransactions(events, rateSchedule);
    const summary = getBalanceStatus(state.advance, state.openDueEntries, asOfDate, rateSchedule);

    // Format open entries exactly as LedgerService.generateLedger does
    const openEntries = state.openDueEntries.map((entry) => {
      const priorUnpaid = entry.unpaidInterest ?? new Decimal(0);
      const { interest } = computeEntryInterest(
        entry.principalAmount,
        entry.date,
        asOfDate,
        rateSchedule,
        priorUnpaid,
      );
      const principal = Math.round((entry.principalAmount.toNumber() + Number.EPSILON) * 100) / 100;
      const accruedInterest = Math.round((interest.toNumber() + Number.EPSILON) * 100) / 100;
      return {
        transactionId: entry.originTransactionId,
        date: entry.date.toISOString(),
        principalAmount: principal,
        accruedInterest,
        totalDue: Math.round((principal + accruedInterest + Number.EPSILON) * 100) / 100,
        isSystemGenerated: entry.originTransactionId === null,
      };
    });

    // 1. Summary assertions
    expect(summary.totalPrincipal.toNumber()).toBe(10000);
    expect(summary.totalInterest.toNumber()).toBe(60);
    expect(summary.displayAmount.toNumber()).toBe(10060);
    expect(summary.unpaidInterest).toBe(60);
    expect(summary.totalDue).toBe(10000); // principal portion of due

    // 2. Detailed open entries assertions
    expect(openEntries).toHaveLength(1);
    expect(openEntries[0].principalAmount).toBe(10000);
    expect(openEntries[0].accruedInterest).toBe(60);
    expect(openEntries[0].totalDue).toBe(10060);
    expect(openEntries[0].isSystemGenerated).toBe(true);

    // 3. Agreement between detailed entries sum and summary display amount
    const totalOpenEntriesDue = openEntries.reduce((sum, e) => sum + e.totalDue, 0);
    expect(totalOpenEntriesDue).toBe(summary.displayAmount.toNumber());
  });

  it('confirms normal entry behavior (zero/undefined unpaidInterest) remains completely unchanged', () => {
    const events: TransactionEvent[] = [
      {
        id: 'tx-debit-normal',
        type: 'DEBIT',
        date: new Date('2025-01-01T00:00:00.000Z'),
        amount: new Decimal(1000),
      },
    ];

    const rateSchedule = 1;
    const asOfDate = new Date('2025-02-01T00:00:00.000Z');

    const state = replayTransactions(events, rateSchedule);
    const summary = getBalanceStatus(state.advance, state.openDueEntries, asOfDate, rateSchedule);

    const openEntries = state.openDueEntries.map((entry) => {
      const priorUnpaid = entry.unpaidInterest ?? new Decimal(0);
      const { interest } = computeEntryInterest(
        entry.principalAmount,
        entry.date,
        asOfDate,
        rateSchedule,
        priorUnpaid,
      );
      const principal = Math.round((entry.principalAmount.toNumber() + Number.EPSILON) * 100) / 100;
      const accruedInterest = Math.round((interest.toNumber() + Number.EPSILON) * 100) / 100;
      return {
        principalAmount: principal,
        accruedInterest,
        totalDue: Math.round((principal + accruedInterest + Number.EPSILON) * 100) / 100,
      };
    });

    expect(summary.totalPrincipal.toNumber()).toBe(1000);
    expect(summary.totalInterest.toNumber()).toBe(10);
    expect(summary.displayAmount.toNumber()).toBe(1010);
    expect(summary.unpaidInterest).toBe(0);

    expect(openEntries[0].principalAmount).toBe(1000);
    expect(openEntries[0].accruedInterest).toBe(10);
    expect(openEntries[0].totalDue).toBe(1010);
  });
});
