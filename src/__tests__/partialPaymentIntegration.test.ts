import { DueAdvanceEngine } from '../utils/dueAdvanceEngine';

describe('Customer Ledger - Partial Payment & Interest Waterfall Logic', () => {
  let engine: DueAdvanceEngine; // Replace with your actual class initialization

  beforeEach(() => {
    // Initialize engine with 2% monthly interest rate
    engine = new DueAdvanceEngine({ monthlyInterestRate: 0.02 });
  });

  it('handles a payment smaller than the accrued interest, leaving principal untouched', () => {
    // Step 1: 1 Jan | Purchase ₹1,000
    engine.processPurchase({ date: '2024-01-01', amount: 1000 });

    // Step 2: 1 Apr | Partial Payment ₹20
    // Time elapsed: 3 months (Jan, Feb, Mar)
    // Accrued Interest = ₹1,000 * 2% * 3 months = ₹60.
    // Total Owed (Principal + Interest) = ₹1,060.
    // Payment of ₹20 is LESS than the ₹60 interest.
    const paymentReceipt1 = engine.processPayment({ date: '2024-04-01', amount: 20 });

    // Assertion: Payment should entirely go to interest. Principal settled should be 0.
    expect(paymentReceipt1.interestSettled).toBe(20);
    expect(paymentReceipt1.principalSettled).toBe(0);

    // Assertion: Principal remains exactly 1000.
    const statusApril = engine.getBalanceStatus('2024-04-01');
    expect(statusApril.totalDue).toBe(1000);
    expect(statusApril.advance).toBe(0);

    // Note: If your engine exposes accrued/unpaid interest in the status, assert it here:
    expect(statusApril.unpaidInterest).toBe(40);
    expect(statusApril.accruedInterest).toBe(40);
    expect(statusApril.totalInterest.toNumber()).toBe(40);
    expect(statusApril.displayAmount.toNumber()).toBe(1040);
  });

  it('proves no interest compounding on unpaid interest across subsequent periods', () => {
    // Step 1: 1 Jan | Purchase ₹1,000
    engine.processPurchase({ date: '2024-01-01', amount: 1000 });

    // Step 2: 1 Apr | Partial Payment ₹20 (Interest accrued: ₹60 -> ₹40 unpaid interest remains)
    engine.processPayment({ date: '2024-04-01', amount: 20 });

    // Step 3: 1 May | Status check after 1 more month
    // Simple Interest Rule: Interest for April is 2% of ₹1,000 principal = ₹20 (NOT 2% of ₹1,040!).
    // Total accrued interest = ₹40 (carried forward) + ₹20 (April) = ₹60.
    const statusMay = engine.getBalanceStatus('2024-05-01');
    expect(statusMay.totalDue).toBe(1000); // Principal is strictly ₹1,000
    expect(statusMay.accruedInterest).toBe(60);
    expect(statusMay.displayAmount.toNumber()).toBe(1060); // ₹1,000 principal + ₹60 interest

    // Step 4: 1 May | Payment of ₹100
    // Waterfall: ₹60 clears ALL accumulated interest, remaining ₹40 reduces principal to ₹960
    const paymentReceipt2 = engine.processPayment({ date: '2024-05-01', amount: 100 });
    expect(paymentReceipt2.interestSettled).toBe(60);
    expect(paymentReceipt2.principalSettled).toBe(40);

    const statusAfterMayPayment = engine.getBalanceStatus('2024-05-01');
    expect(statusAfterMayPayment.totalDue).toBe(960);
    expect(statusAfterMayPayment.advance).toBe(0);
    expect(statusAfterMayPayment.unpaidInterest).toBe(0);
    expect(statusAfterMayPayment.accruedInterest).toBe(0);

    // Step 5: 1 Jun | Full clearing payment of ₹1,000
    // Time: 1 month on ₹960 principal @ 2% = ₹19.20 interest. Total Owed = ₹979.20.
    // Payment ₹1,000 clears ₹19.20 interest, ₹960 principal, leaves ₹20.80 Advance!
    const paymentReceipt3 = engine.processPayment({ date: '2024-06-01', amount: 1000 });
    expect(paymentReceipt3.interestSettled).toBeCloseTo(19.2, 2);
    expect(paymentReceipt3.principalSettled).toBe(960);

    const statusJune = engine.getBalanceStatus('2024-06-01');
    expect(statusJune.totalDue).toBe(0);
    expect(statusJune.advance).toBeCloseTo(20.8, 2);
  });
});
