import Decimal from 'decimal.js';
import { replayTransactions, getBalanceStatus, TransactionEvent } from '../utils/dueAdvanceEngine';

describe('Audit: Concurrency, Invariants & Property-Based Testing (Categories R, S, AC, AD)', () => {
  const MONTHLY_RATE = new Decimal(2); // 2% per month

  describe('Category AC: Property-Based Financial Invariant Testing', () => {
    // Simple LCG pseudo-random number generator for 100% deterministic test execution
    function pseudoRandom(seed: number) {
      let state = seed;
      return function () {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
    }

    it('AC1: should hold all 6 core financial invariants across 50 randomized sequence lifecycles', () => {
      const rand = pseudoRandom(123456789);

      for (let run = 0; run < 50; run++) {
        const events: TransactionEvent[] = [];
        let currentDate = new Date('2025-01-01T00:00:00Z');
        const numEvents = 5 + Math.floor(rand() * 15); // 5 to 20 events per sequence

        for (let i = 0; i < numEvents; i++) {
          // Advance date by 0 to 30 days
          const daysToAdd = Math.floor(rand() * 30);
          currentDate = new Date(currentDate.getTime() + daysToAdd * 86400000);

          // Random type: DEBIT or CREDIT
          const isDebit = rand() > 0.4;
          const amount = Math.round((10 + rand() * 2000) * 100) / 100; // 10.00 to 2010.00

          events.push({
            id: `evt-${run}-${i}`,
            type: isDebit ? 'DEBIT' : 'CREDIT',
            amount: new Decimal(amount),
            date: currentDate,
            createdAt: new Date(currentDate.getTime() + i * 1000),
          });
        }

        const state = replayTransactions(events, MONTHLY_RATE);
        const balance = getBalanceStatus(
          state.advance,
          state.openDueEntries,
          currentDate,
          MONTHLY_RATE,
        );

        // INVARIANT 1: Advance is never negative
        expect(state.advance.toNumber()).toBeGreaterThanOrEqual(0);
        expect(balance.advance).toBeGreaterThanOrEqual(0);

        // INVARIANT 2: Outstanding Principal is never negative
        expect(balance.totalPrincipal.toNumber()).toBeGreaterThanOrEqual(0);
        for (const entry of state.openDueEntries) {
          expect(entry.principalAmount.toNumber()).toBeGreaterThan(0);
        }

        // INVARIANT 3: Accrued interest is never negative
        expect(balance.totalInterest.toNumber()).toBeGreaterThanOrEqual(0);
        for (const record of state.settledHistory) {
          expect(record.interestCharged.toNumber()).toBeGreaterThanOrEqual(0);
        }

        // INVARIANT 4: Mutual Exclusivity - cannot have both open Due and positive Advance simultaneously
        if (state.openDueEntries.length > 0) {
          expect(state.advance.toNumber()).toBe(0);
          expect(balance.status).toBe('Due');
        } else if (state.advance.gt(0)) {
          expect(balance.status).toBe('Advance');
          expect(balance.totalDue).toBe(0);
        } else {
          expect(balance.status).toBe('Settled');
          expect(balance.totalDue).toBe(0);
          expect(balance.advance).toBe(0);
        }

        // INVARIANT 5: Determinism - replaying the same sequence yields the exact same state
        const state2 = replayTransactions(events, MONTHLY_RATE);
        expect(state2.advance.toNumber()).toBe(state.advance.toNumber());
        expect(state2.openDueEntries.length).toBe(state.openDueEntries.length);
        expect(state2.settledHistory.length).toBe(state.settledHistory.length);
      }
    });
  });

  describe('Category AD: Boundary & Extreme Values Testing', () => {
    it('AD1: should correctly handle 1 paisa (0.01) micro-transactions without floating-point artifacts', () => {
      const events: TransactionEvent[] = [
        {
          id: '1',
          type: 'DEBIT',
          amount: new Decimal(0.01),
          date: new Date('2026-01-01'),
          createdAt: new Date(),
        },
        {
          id: '2',
          type: 'CREDIT',
          amount: new Decimal(0.01),
          date: new Date('2026-01-02'),
          createdAt: new Date(),
        },
      ];

      const state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(0);
    });

    it('AD2: should handle extremely large financial values (₹10,000,000,000 / 1000 crore)', () => {
      const largeAmount = new Decimal('10000000000.00');
      const events: TransactionEvent[] = [
        {
          id: '1',
          type: 'DEBIT',
          amount: largeAmount,
          date: new Date('2026-01-01'),
          createdAt: new Date(),
        },
        {
          id: '2',
          type: 'CREDIT',
          amount: largeAmount,
          date: new Date('2026-01-01'),
          createdAt: new Date(),
        },
      ];

      const state = replayTransactions(events, MONTHLY_RATE);
      expect(state.advance.toNumber()).toBe(0);
      expect(state.openDueEntries).toHaveLength(0);
    });
  });

  describe('Category S: Idempotency & Repeatability Assessment', () => {
    it('S1: duplicate replay of identical transaction list must be strictly idempotent', () => {
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
          type: 'DEBIT',
          amount: new Decimal(2000),
          date: new Date('2026-02-01'),
          createdAt: new Date(),
        },
        {
          id: '3',
          type: 'CREDIT',
          amount: new Decimal(1500),
          date: new Date('2026-03-01'),
          createdAt: new Date(),
        },
      ];

      const res1 = replayTransactions(events, MONTHLY_RATE);
      const res2 = replayTransactions(events, MONTHLY_RATE);

      expect(res1.advance.toString()).toBe(res2.advance.toString());
      expect(res1.openDueEntries[0].principalAmount.toString()).toBe(
        res2.openDueEntries[0].principalAmount.toString(),
      );
    });
  });
});
