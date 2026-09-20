import { DueAdvanceEngine } from '../utils/dueAdvanceEngine';

describe('Customer Ledger Core Logic - Interest & Advance (ABC Traders)', () => {
  let engine: DueAdvanceEngine; // Replace with your actual class/engine initialization

  beforeEach(() => {
    // Initialize engine with 2% monthly interest rate
    engine = new DueAdvanceEngine({ monthlyInterestRate: 0.02 });
  });

  it('accurately tracks due, calculates accrued interest, and maintains advance balances through a complex 6-month scenario', () => {
    // Step 1: 1 Jan | Purchase ₹1,000
    engine.processPurchase({ date: '2024-01-01', amount: 1000 });
    let status = engine.getBalanceStatus('2024-01-01');
    expect(status.totalDue).toBe(1000);
    expect(status.advance).toBe(0);

    // Step 2: 1 Feb | Purchase ₹1,000
    engine.processPurchase({ date: '2024-02-01', amount: 1000 });
    status = engine.getBalanceStatus('2024-02-01');
    expect(status.totalDue).toBe(2000); // 1000 from Jan + 1000 from Feb

    // Step 3: 1 Mar | Purchase ₹1,000
    engine.processPurchase({ date: '2024-03-01', amount: 1000 });
    status = engine.getBalanceStatus('2024-03-01');
    expect(status.totalDue).toBe(3000);

    // Step 4: 1 Apr | Payment ₹4,000
    // Logic:
    // Jan ₹1,000 (3 months) = ₹60 interest
    // Feb ₹1,000 (2 months) = ₹40 interest
    // Mar ₹1,000 (1 month) = ₹20 interest
    // Total Interest = ₹120. Total Due + Interest = ₹3120.
    // Payment 4000 - 3120 = 880 Advance.
    const paymentReceipt1 = engine.processPayment({ date: '2024-04-01', amount: 4000 });
    expect(paymentReceipt1.interestSettled).toBe(120);
    expect(paymentReceipt1.principalSettled).toBe(3000);

    status = engine.getBalanceStatus('2024-04-01');
    expect(status.totalDue).toBe(0);
    expect(status.advance).toBe(880);

    // Step 5: 15 Apr | Purchase ₹500
    // Logic: Deducted from ₹880 Advance. ₹880 - ₹500 = ₹380 Advance.
    engine.processPurchase({ date: '2024-04-15', amount: 500 });
    status = engine.getBalanceStatus('2024-04-15');
    expect(status.totalDue).toBe(0);
    expect(status.advance).toBe(380);

    // Step 6: 20 Apr | Purchase ₹1,000
    // Logic: ₹380 Advance consumed. Remaining ₹620 becomes Due on 20 Apr.
    engine.processPurchase({ date: '2024-04-20', amount: 1000 });
    status = engine.getBalanceStatus('2024-04-20');
    expect(status.advance).toBe(0);
    expect(status.totalDue).toBe(620);

    // Step 7: 20 May | Payment ₹1,000
    // Logic: 1 month interest on ₹620 = ₹12.40. Total Due = 632.40.
    // Payment 1000 - 632.40 = 367.60 Advance.
    const paymentReceipt2 = engine.processPayment({ date: '2024-05-20', amount: 1000 });
    // Using closeTo for floating point assertions
    expect(paymentReceipt2.interestSettled).toBeCloseTo(12.4, 2);
    expect(paymentReceipt2.principalSettled).toBe(620);

    status = engine.getBalanceStatus('2024-05-20');
    expect(status.totalDue).toBe(0);
    expect(status.advance).toBeCloseTo(367.6, 2);

    // Step 8: 1 Jun | Purchase ₹500
    // Logic: Deducted from 367.60 Advance. Remaining ₹132.40 becomes Due.
    engine.processPurchase({ date: '2024-06-01', amount: 500 });
    status = engine.getBalanceStatus('2024-06-01');
    expect(status.advance).toBe(0);
    expect(status.totalDue).toBeCloseTo(132.4, 2);
  });
});
