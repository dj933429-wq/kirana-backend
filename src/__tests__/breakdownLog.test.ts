import { LedgerService } from '../services/ledger.service';
import { prisma } from '../config/database';

jest.mock('../config/database', () => ({
  prisma: {
    customer: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    transaction: {
      findMany: jest.fn(),
    },
    customerInterestRate: {
      findMany: jest.fn(),
    },
  },
}));

describe('Authoritative Interest Calculation Breakdown (breakdownLog)', () => {
  let ledgerService: LedgerService;

  beforeEach(() => {
    jest.clearAllMocks();
    ledgerService = new LedgerService();
  });

  it('ABC Traders: generates authoritative per-entry breakdown matching exact calendar accounting', async () => {
    const userId = 'user-abc';
    const customerId = 'cust-abc';

    // Mock Customer at 2% monthly interest
    (prisma.customer.findFirst as jest.Mock).mockResolvedValue({
      id: customerId,
      userId,
      name: 'ABC Traders',
      interestRate: 2,
      isActive: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
      id: customerId,
      userId,
      name: 'ABC Traders',
      interestRate: 2,
      isActive: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    (prisma.customerInterestRate.findMany as jest.Mock).mockResolvedValue([]);

    // Step 1 - 4: 1 Jan (1000 D), 1 Feb (1000 D), 1 Mar (1000 D), 1 Apr (4000 C)
    const txPhase1 = [
      {
        id: 'tx-jan-1',
        customerId,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2024-01-01T00:00:00.000Z'),
        createdAt: new Date('2024-01-01T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-feb-1',
        customerId,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2024-02-01T00:00:00.000Z'),
        createdAt: new Date('2024-02-01T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-mar-1',
        customerId,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2024-03-01T00:00:00.000Z'),
        createdAt: new Date('2024-03-01T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-apr-1',
        customerId,
        type: 'CREDIT',
        amount: 4000,
        date: new Date('2024-04-01T00:00:00.000Z'),
        createdAt: new Date('2024-04-01T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
    ];

    (prisma.transaction.findMany as jest.Mock).mockResolvedValue(txPhase1);

    const ledgerApr1 = await ledgerService.generateLedger(
      userId,
      customerId,
      new Date('2024-04-01T00:00:00.000Z'),
    );

    // Summary assertions
    expect(ledgerApr1.summary.status).toBe('Advance');
    expect(ledgerApr1.summary.advance).toBe(880);
    expect(ledgerApr1.summary.totalDue).toBe(0);

    // Authoritative breakdown log assertions
    const settledLogs = ledgerApr1.breakdownLog.filter((b) => b.isSettled);
    expect(settledLogs).toHaveLength(3);

    // Entry 1 (1 Jan): ₹1,000 for 3 calendar months @ 2% = ₹60
    expect(settledLogs[0]).toMatchObject({
      transactionId: 'tx-jan-1',
      principalAmount: 1000,
      monthsElapsed: 3,
      ratePercent: 2,
      interestCharged: 60,
      isSettled: true,
      isAdvance: false,
      settledByPaymentId: 'tx-apr-1',
    });

    // Entry 2 (1 Feb): ₹1,000 for 2 calendar months @ 2% = ₹40
    expect(settledLogs[1]).toMatchObject({
      transactionId: 'tx-feb-1',
      principalAmount: 1000,
      monthsElapsed: 2,
      ratePercent: 2,
      interestCharged: 40,
      isSettled: true,
      isAdvance: false,
      settledByPaymentId: 'tx-apr-1',
    });

    // Entry 3 (1 Mar): ₹1,000 for 1 calendar month @ 2% = ₹20
    expect(settledLogs[2]).toMatchObject({
      transactionId: 'tx-mar-1',
      principalAmount: 1000,
      monthsElapsed: 1,
      ratePercent: 2,
      interestCharged: 20,
      isSettled: true,
      isAdvance: false,
      settledByPaymentId: 'tx-apr-1',
    });

    // Total settled interest = ₹60 + ₹40 + ₹20 = ₹120
    const totalSettledInterest = settledLogs.reduce((sum, item) => sum + item.interestCharged, 0);
    expect(totalSettledInterest).toBe(120);

    // Advance breakdown log item shows 0% interest
    const advanceLog = ledgerApr1.breakdownLog.find((b) => b.isAdvance);
    expect(advanceLog).toBeDefined();
    expect(advanceLog).toMatchObject({
      principalAmount: 880,
      interestCharged: 0,
      ratePercent: 0,
      isAdvance: true,
      isSettled: false,
    });

    // Full sequence up to 1 Jun:
    // 15 Apr: 500 DEBIT
    // 20 Apr: 1000 DEBIT
    // 20 May: 1000 CREDIT
    // 1 Jun: 500 DEBIT
    const txFullSequence = [
      ...txPhase1,
      {
        id: 'tx-apr-15',
        customerId,
        type: 'DEBIT',
        amount: 500,
        date: new Date('2024-04-15T00:00:00.000Z'),
        createdAt: new Date('2024-04-15T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-apr-20',
        customerId,
        type: 'DEBIT',
        amount: 1000,
        date: new Date('2024-04-20T00:00:00.000Z'),
        createdAt: new Date('2024-04-20T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-may-20',
        customerId,
        type: 'CREDIT',
        amount: 1000,
        date: new Date('2024-05-20T00:00:00.000Z'),
        createdAt: new Date('2024-05-20T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-jun-1',
        customerId,
        type: 'DEBIT',
        amount: 500,
        date: new Date('2024-06-01T00:00:00.000Z'),
        createdAt: new Date('2024-06-01T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
    ];

    (prisma.transaction.findMany as jest.Mock).mockResolvedValue(txFullSequence);

    const ledgerJun1 = await ledgerService.generateLedger(
      userId,
      customerId,
      new Date('2024-06-01T00:00:00.000Z'),
    );

    // Final balance assertions as of 1 Jun
    expect(ledgerJun1.summary.status).toBe('Due');
    expect(ledgerJun1.summary.totalPrincipal).toBe(132.4);
    expect(ledgerJun1.summary.accruedInterest).toBe(0);
    expect(ledgerJun1.summary.advance).toBe(0);
    expect(ledgerJun1.summary.totalDue).toBe(132.4);

    // Settled entry from 20 May payment: ₹620 principal for 1 month @ 2% = ₹12.40 interest
    const maySettled = ledgerJun1.breakdownLog.find((b) => b.settledByPaymentId === 'tx-may-20');
    expect(maySettled).toBeDefined();
    expect(maySettled).toMatchObject({
      principalAmount: 620,
      monthsElapsed: 1,
      interestCharged: 12.4,
      isSettled: true,
      isAdvance: false,
    });

    // Open entry as of 1 Jun: ₹132.40 principal with 0 interest
    const openJunEntry = ledgerJun1.breakdownLog.find((b) => !b.isSettled && !b.isAdvance);
    expect(openJunEntry).toBeDefined();
    expect(openJunEntry).toMatchObject({
      transactionId: 'tx-jun-1',
      principalAmount: 132.4,
      interestCharged: 0,
      isSettled: false,
      isAdvance: false,
    });
  });

  it('Canonical Ramesh scenario: preserves correct ledger and breakdown without regression', async () => {
    const userId = 'user-ramesh';
    const customerId = 'cust-ramesh';

    (prisma.customer.findFirst as jest.Mock).mockResolvedValue({
      id: customerId,
      userId,
      name: 'Ramesh Kumar',
      interestRate: 1,
      isActive: true,
      createdAt: new Date('2023-08-27T00:00:00.000Z'),
      updatedAt: new Date('2023-08-27T00:00:00.000Z'),
    });
    (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
      id: customerId,
      userId,
      name: 'Ramesh Kumar',
      interestRate: 1,
      isActive: true,
      createdAt: new Date('2023-08-27T00:00:00.000Z'),
      updatedAt: new Date('2023-08-27T00:00:00.000Z'),
    });
    (prisma.customerInterestRate.findMany as jest.Mock).mockResolvedValue([]);

    const rameshTransactions = [
      {
        id: 'tx-1',
        customerId,
        type: 'DEBIT',
        amount: 40000,
        date: new Date('2023-08-27T00:00:00.000Z'),
        createdAt: new Date('2023-08-27T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-2',
        customerId,
        type: 'CREDIT',
        amount: 50000,
        date: new Date('2023-12-27T00:00:00.000Z'),
        createdAt: new Date('2023-12-27T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
      {
        id: 'tx-3',
        customerId,
        type: 'DEBIT',
        amount: 40000,
        date: new Date('2024-03-27T00:00:00.000Z'),
        createdAt: new Date('2024-03-27T10:00:00.000Z'),
        isVoided: false,
        isSystemGenerated: false,
      },
    ];

    (prisma.transaction.findMany as jest.Mock).mockResolvedValue(rameshTransactions);

    const ledger = await ledgerService.generateLedger(
      userId,
      customerId,
      new Date('2024-04-27T00:00:00.000Z'),
    );

    // Expected: Principal = 31,600, Interest = 316, Total Due = 31,916
    expect(ledger.summary.totalPrincipal).toBe(31600);
    expect(ledger.summary.accruedInterest).toBe(316);
    expect(ledger.summary.totalDue).toBe(31916);
    expect(ledger.summary.displayAmount).toBe(31916);

    // Breakdown assertions
    const settledItem = ledger.breakdownLog.find((b) => b.isSettled);
    expect(settledItem).toMatchObject({
      principalAmount: 40000,
      monthsElapsed: 4,
      interestCharged: 1600,
      isSettled: true,
      settledByPaymentId: 'tx-2',
    });

    const openItem = ledger.breakdownLog.find((b) => !b.isSettled);
    expect(openItem).toMatchObject({
      principalAmount: 31600,
      monthsElapsed: 1,
      interestCharged: 316,
      isSettled: false,
    });

    // Ensure 1626.67 is NOT present anywhere
    const jsonStr = JSON.stringify(ledger);
    expect(jsonStr).not.toContain('1626.67');
  });
});
