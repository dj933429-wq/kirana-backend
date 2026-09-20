import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { Customer, Transaction, TransactionType } from '../generated/prisma/client';
import { Decimal } from 'decimal.js';
import {
  replayTransactions,
  getBalanceStatus,
  computeEntryInterest,
  TransactionEvent,
  ReplayState,
  RateChange,
} from '../utils/dueAdvanceEngine';

// ============ Exported Types ============

export interface LedgerDueEntry {
  transactionId: string | null;
  date: string;
  principalAmount: number;
  accruedInterest: number;
  totalDue: number;
  isSystemGenerated: boolean;
}

export interface LedgerSettledEntry {
  transactionId: string | null;
  date: string;
  principalAmount: number;
  interestCharged: number;
  settledAt: string;
  settledByPaymentId: string;
}

export interface LedgerSummary {
  status: 'Due' | 'Advance' | 'Settled';
  displayAmount: number;
  totalPrincipal: number;
  accruedInterest: number;
  totalDue: number;
  advance: number;
  totalMoneyLent: number;
  totalMoneyReceived: number;
}

export interface LedgerResult {
  customer: Customer;
  summary: LedgerSummary;
  openEntries: LedgerDueEntry[];
  settledEntries: LedgerSettledEntry[];
  transactions: Transaction[];
}

export class LedgerService {
  /**
   * Generates the customer ledger by replaying all user-created transactions
   * through the Due/Advance engine. Read-only — does not modify any DB records.
   */
  public async generateLedger(
    userId: string,
    customerId: string,
    calculationDate: Date = new Date(),
  ): Promise<LedgerResult> {
    // 1. Fetch customer and verify existence & ownership
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });

    if (!customer) {
      throw new AppError('Customer not found.', 404);
    }

    // 2. Fetch all non-voided, non-system-generated transactions (source of truth)
    const userTransactions = await prisma.transaction.findMany({
      where: { customerId, isVoided: false, isSystemGenerated: false },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    // 3. Convert to engine events
    const events: TransactionEvent[] = userTransactions.map((tx) => ({
      id: tx.id,
      type: tx.type as 'DEBIT' | 'CREDIT',
      date: new Date(tx.date),
      amount: new Decimal(tx.amount.toString()),
      createdAt: new Date(tx.createdAt),
    }));

    // 4. Build customer rate schedule
    const rateSchedule = await this.getCustomerRateSchedule(customerId);

    // 5. Replay through the pure engine
    const state = replayTransactions(events, rateSchedule);

    // 6. Compute display status as of calculationDate
    const balanceStatus = getBalanceStatus(
      state.advance,
      state.openDueEntries,
      calculationDate,
      rateSchedule,
    );

    // 7. Format open entries with accrued interest for display
    const openEntries: LedgerDueEntry[] = state.openDueEntries.map((entry) => {
      const { interest } = computeEntryInterest(
        entry.principalAmount,
        entry.date,
        calculationDate,
        rateSchedule,
      );
      const principal = this.decToNum(entry.principalAmount);
      const accruedInterest = this.decToNum(interest);
      return {
        transactionId: entry.originTransactionId,
        date: entry.date.toISOString(),
        principalAmount: principal,
        accruedInterest,
        totalDue: this.roundTo2(principal + accruedInterest),
        isSystemGenerated: entry.originTransactionId === null,
      };
    });

    // 7. Format settled entries for audit trail
    const settledEntries: LedgerSettledEntry[] = state.settledHistory.map((record) => ({
      transactionId: record.entryOriginTransactionId,
      date: record.entryDate.toISOString(),
      principalAmount: this.decToNum(record.entryPrincipal),
      interestCharged: this.decToNum(record.interestCharged),
      settledAt: record.settledAt.toISOString(),
      settledByPaymentId: record.settledByPaymentId,
    }));

    // 8. Compute money flow totals
    let totalMoneyLent = 0;
    let totalMoneyReceived = 0;
    for (const tx of userTransactions) {
      const amount = Number(tx.amount);
      if (tx.type === TransactionType.DEBIT) totalMoneyLent += amount;
      else totalMoneyReceived += amount;
    }

    const summary: LedgerSummary = {
      status: balanceStatus.status,
      displayAmount: this.decToNum(balanceStatus.displayAmount),
      totalPrincipal: this.decToNum(balanceStatus.totalPrincipal),
      accruedInterest: this.decToNum(balanceStatus.totalInterest),
      totalDue: balanceStatus.status === 'Due' ? this.decToNum(balanceStatus.displayAmount) : 0,
      advance: this.decToNum(state.advance),
      totalMoneyLent: this.roundTo2(totalMoneyLent),
      totalMoneyReceived: this.roundTo2(totalMoneyReceived),
    };

    // Fetch all transactions (including system-generated) for the full list
    const allTransactions = await prisma.transaction.findMany({
      where: { customerId, isVoided: false },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    return {
      customer,
      summary,
      openEntries,
      settledEntries,
      transactions: allTransactions,
    };
  }

  /**
   * Full reconciliation: replays all user transactions and persists the computed
   * state as a materialized cache. Called after every createTransaction and
   * voidTransaction to keep cached fields consistent with the source of truth.
   *
   * @param customerId - The customer to reconcile
   * @param txClient - Optional Prisma transaction client for atomicity
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async reconcileCustomerLedger(customerId: string, txClient?: any): Promise<void> {
    const db = txClient || prisma;

    // 1. Delete all system-generated entries (they'll be recreated if needed)
    await db.transaction.deleteMany({
      where: { customerId, isSystemGenerated: true },
    });

    // 2. Clear all cached settlement fields on remaining transactions
    await db.transaction.updateMany({
      where: { customerId, isVoided: false },
      data: {
        isSettled: false,
        settledAt: null,
        settledByPaymentId: null,
        interestCharged: null,
        outstandingPrincipal: null,
      },
    });

    // 3. Fetch customer
    const customer = await db.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) return;

    // 4. Fetch all remaining non-voided transactions (user-created only now)
    const dbTransactions = await db.transaction.findMany({
      where: { customerId, isVoided: false },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });

    // 5. Convert to engine events
    const events: TransactionEvent[] = dbTransactions.map((tx: Transaction) => ({
      id: tx.id,
      type: tx.type as 'DEBIT' | 'CREDIT',
      date: new Date(tx.date),
      amount: new Decimal(tx.amount.toString()),
      createdAt: new Date(tx.createdAt),
    }));

    // 6. Replay through the pure engine with historical rate schedule
    const rateSchedule = await this.getCustomerRateSchedule(customerId);
    const state: ReplayState = replayTransactions(events, rateSchedule);

    // 7. Update cached fields on settled transactions
    for (const record of state.settledHistory) {
      if (record.entryOriginTransactionId) {
        await db.transaction.update({
          where: { id: record.entryOriginTransactionId },
          data: {
            isSettled: true,
            settledAt: record.settledAt,
            settledByPaymentId: record.settledByPaymentId,
            interestCharged: record.interestCharged.toDecimalPlaces(2).toNumber(),
          },
        });
      }
    }

    // 8. Update outstandingPrincipal for all DEBIT transactions with advance usage
    for (const [txId, usage] of state.advanceUsageByTransaction) {
      await db.transaction.update({
        where: { id: txId },
        data: {
          outstandingPrincipal: usage.outstandingPrincipal.toDecimalPlaces(2).toNumber(),
        },
      });
    }

    // 9. Create system-generated entries for open consolidated due entries
    for (const entry of state.openDueEntries) {
      if (entry.originTransactionId === null && entry.originPaymentId) {
        await db.transaction.create({
          data: {
            customerId,
            type: TransactionType.DEBIT,
            amount: entry.principalAmount.toDecimalPlaces(2).toNumber(),
            date: entry.date,
            interestStartDate: entry.date,
            outstandingPrincipal: entry.principalAmount.toDecimalPlaces(2).toNumber(),
            isSystemGenerated: true,
            createdByPaymentId: entry.originPaymentId,
            isVoided: false,
            isSettled: false,
          },
        });
      }
    }

    // 10. Update customer's advance balance
    await db.customer.update({
      where: { id: customerId },
      data: {
        advanceBalance: state.advance.toDecimalPlaces(2).toNumber(),
      },
    });
  }

  /** Convert Decimal to number, rounded to 2 decimal places */
  private decToNum(val: Decimal): number {
    return Math.round((val.toNumber() + Number.EPSILON) * 100) / 100;
  }

  private roundTo2(val: number): number {
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }

  /**
   * Fetches the historical rate schedule for a customer.
   * Uses customer_interest_rates records ordered by effectiveDate asc.
   * If customer.interestRate differs from the latest record, incorporates it
   * effective from customer.updatedAt.
   * Falls back to customer.createdAt with customer.interestRate.
   */
  public async getCustomerRateSchedule(customerId: string): Promise<RateChange[]> {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) return [];

    const history = await prisma.customerInterestRate.findMany({
      where: { customerId },
      orderBy: { effectiveDate: 'asc' },
    });

    const schedule: RateChange[] = [];

    if (history.length > 0) {
      if (new Date(history[0].effectiveDate).getTime() > 0) {
        schedule.push({
          effectiveDate: new Date(0),
          monthlyRatePercent: new Decimal(0),
        });
      }
      for (const h of history) {
        schedule.push({
          effectiveDate: new Date(h.effectiveDate),
          monthlyRatePercent: new Decimal(h.interestRate.toString()),
        });
      }
    } else {
      schedule.push({
        effectiveDate: new Date(0),
        monthlyRatePercent: new Decimal(customer.interestRate.toString()),
      });
    }

    const currentRate = new Decimal(customer.interestRate.toString());
    const lastRate = schedule[schedule.length - 1].monthlyRatePercent;
    if (!lastRate.equals(currentRate)) {
      schedule.push({
        effectiveDate: new Date(customer.updatedAt),
        monthlyRatePercent: currentRate,
      });
    }

    return schedule;
  }
}
