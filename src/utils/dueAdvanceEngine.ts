/**
 * Due/Advance Ledger Engine
 *
 * Pure, independently testable calculation functions for the Due/Advance
 * customer balance model. No database dependencies — uses Decimal.js for
 * precision financial arithmetic.
 *
 * Business Model:
 * - Purchases create dated "due entries" (each tracks independent interest accrual)
 * - Advance balance absorbs purchases before creating new due entries
 * - Payments settle ALL open due entries at once (charging interest), excess → advance
 * - Interest: simple, monthly rate, calendar-month proration
 * - Waterfalls: Payments pay interest first, then principal
 */

import { Decimal } from 'decimal.js';

// Configure Decimal.js for financial precision (20 digits precision, Half-Up rounding)
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ============ Error Classes ============

export class ChronologyError extends Error {
  constructor(message: string = 'Transactions must be processed in chronological order') {
    super(message);
    this.name = 'ChronologyError';
  }
}

export class InvalidDateOrderError extends ChronologyError {
  constructor(message: string = 'Transactions must be processed in chronological order') {
    super(message);
    this.name = 'InvalidDateOrderError';
  }
}

export class InvalidAmountError extends Error {
  constructor(message: string = 'Amount must be greater than zero') {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

// ============ Types ============

export interface DueEntry {
  date: Date;
  principalAmount: Decimal;
  /** Unpaid interest carried forward when a partial payment covers only partial interest */
  unpaidInterest?: Decimal;
  /** ID of the original purchase transaction (null for system-generated consolidated entries) */
  originTransactionId: string | null;
  /** ID of the payment that created this consolidated entry (null for regular purchases) */
  originPaymentId: string | null;
}

export interface SettledEntryResult {
  date: Date;
  principalAmount: Decimal;
  interestCharged: Decimal;
  monthsElapsed: Decimal;
  originTransactionId: string | null;
  originPaymentId: string | null;
}

export interface SettlementResult {
  settledEntries: SettledEntryResult[];
  totalPrincipal: Decimal;
  totalInterest: Decimal;
  totalOwed: Decimal;
  /** Amount remaining after paying totalOwed (goes to advance). Zero if underpayment. */
  remainingPayment: Decimal;
  /** Remaining unpaid interest when payment < totalInterest */
  unpaidInterest: Decimal;
  /** Created when payment < totalOwed. One consolidated entry with the shortfall. */
  newConsolidatedEntry: {
    date: Date;
    principalAmount: Decimal;
    unpaidInterest: Decimal;
  } | null;
}

export interface PurchaseResult {
  newAdvance: Decimal;
  newDueEntry: DueEntry | null;
  outstandingPrincipal: Decimal;
  advanceUsed: Decimal;
}

export interface PaymentResult {
  newAdvance: Decimal;
  settlement: SettlementResult | null;
  interestSettled: number;
  principalSettled: number;
  advanceRemaining: number;
}

export interface TransactionEvent {
  id: string;
  type: 'DEBIT' | 'CREDIT';
  date: Date;
  amount: Decimal;
  createdAt?: Date;
}

export interface AdvanceUsageRecord {
  transactionId: string;
  advanceUsed: Decimal;
  outstandingPrincipal: Decimal;
}

export interface SettlementRecord {
  entryDate: Date;
  entryPrincipal: Decimal;
  entryOriginTransactionId: string | null;
  entryOriginPaymentId: string | null;
  interestCharged: Decimal;
  monthsElapsed: Decimal;
  settledByPaymentId: string;
  settledAt: Date;
}

export interface ReplayState {
  advance: Decimal;
  openDueEntries: DueEntry[];
  settledHistory: SettlementRecord[];
  advanceUsageByTransaction: Map<string, AdvanceUsageRecord>;
}

export interface BalanceStatus {
  status: 'Due' | 'Advance' | 'Settled';
  displayAmount: Decimal;
  totalPrincipal: Decimal;
  totalInterest: Decimal;
  totalDue: number;
  advance: number;
  accruedInterest: number;
  unpaidInterest: number;
}

export interface DueAdvanceEngineConfig {
  monthlyInterestRate?: number | Decimal;
  monthlyRatePercent?: number | Decimal;
}

export interface RateChange {
  effectiveDate: Date;
  monthlyRatePercent: Decimal;
}

export type RateSchedule =
  { effectiveDate: Date; monthlyRatePercent: Decimal | number }[] | Decimal | number;

/**
 * Normalizes a RateSchedule (single rate or array of RateChanges) into a sorted list
 * of { effectiveDate: Date, monthlyRatePercent: Decimal }, sorted by effectiveDate ascending.
 */
export function normalizeRateSchedule(
  rateScheduleOrRate: RateSchedule,
  defaultDate: Date = new Date(0),
): { effectiveDate: Date; monthlyRatePercent: Decimal }[] {
  if (Array.isArray(rateScheduleOrRate)) {
    if (rateScheduleOrRate.length === 0) {
      return [{ effectiveDate: defaultDate, monthlyRatePercent: new Decimal(0) }];
    }
    return rateScheduleOrRate
      .map((r) => ({
        effectiveDate: normalizeToUTCMidnight(r.effectiveDate),
        monthlyRatePercent: new Decimal(r.monthlyRatePercent),
      }))
      .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  }
  const rate = new Decimal(rateScheduleOrRate);
  return [{ effectiveDate: defaultDate, monthlyRatePercent: rate }];
}

/**
 * Returns the effective monthly rate percentage active as of a given date
 * according to the provided rate schedule.
 */
export function getEffectiveRateAt(
  schedule: { effectiveDate: Date; monthlyRatePercent: Decimal }[],
  date: Date,
): Decimal {
  const normDate = normalizeToUTCMidnight(date).getTime();
  let effective = schedule[0].monthlyRatePercent;
  for (const rc of schedule) {
    if (rc.effectiveDate.getTime() <= normDate) {
      effective = rc.monthlyRatePercent;
    } else {
      break;
    }
  }
  return effective;
}

// ============ Helper Functions ============

/**
 * Rounds any financial Decimal or number strictly to 2 decimal places using ROUND_HALF_UP.
 */
export function roundCurrency(val: Decimal | number): Decimal {
  return new Decimal(val).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Returns the number of days in a calendar month.
 * @param year Full year (e.g. 2026)
 * @param month 0-indexed month (0 = January, 11 = December)
 */
export function daysInCalendarMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Normalizes a Date to UTC midnight (00:00:00.000Z) for day-level comparison,
 * stripping hours, minutes, seconds, milliseconds, and time zone offsets.
 */
export function normalizeToUTCMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ============ Core Calculation Functions ============

/**
 * Computes the number of calendar months elapsed between two dates.
 *
 * Advances by full calendar months from startDate, anchoring on the start date's
 * day-of-month (clamped to the last day of shorter months, e.g. Feb 29 -> Feb 28).
 * The remaining partial month is prorated as: extra_days / days_in_that_calendar_month.
 *
 * Examples:
 * - Jan 1 -> Apr 1 = 3.0 (exact months)
 * - Jan 31 -> Feb 28 = 1.0 (clamped to month-end)
 * - Feb 29, 2024 -> Feb 28, 2025 = 12.0 (leap year clamped)
 * - Jan 1 -> Jan 15 = 14/31 ≈ 0.4516
 */
export function computeMonthsElapsed(startDate: Date, endDate: Date): Decimal {
  const start = normalizeToUTCMidnight(startDate);
  const end = normalizeToUTCMidnight(endDate);

  if (end.getTime() <= start.getTime()) return new Decimal(0);

  const startDay = start.getUTCDate();
  let fullMonths = 0;
  let cursorY = start.getUTCFullYear();
  let cursorM = start.getUTCMonth();

  // Count full calendar months by advancing from startDate
  while (true) {
    let nextM = cursorM + 1;
    let nextY = cursorY;
    if (nextM > 11) {
      nextM = 0;
      nextY++;
    }

    const maxDay = daysInCalendarMonth(nextY, nextM);
    const nextD = Math.min(startDay, maxDay);
    const nextDate = new Date(Date.UTC(nextY, nextM, nextD));

    if (nextDate.getTime() > end.getTime()) break;

    fullMonths++;
    cursorY = nextY;
    cursorM = nextM;
  }

  // Cursor date is the last full-month boundary
  const cursorD = Math.min(startDay, daysInCalendarMonth(cursorY, cursorM));
  const cursorDate = new Date(Date.UTC(cursorY, cursorM, cursorD));

  // Compute remaining days
  const msDiff = end.getTime() - cursorDate.getTime();
  const extraDays = Math.round(msDiff / (1000 * 60 * 60 * 24));

  if (extraDays <= 0) return new Decimal(fullMonths);

  // Prorate partial month
  const dimCursor = daysInCalendarMonth(cursorY, cursorM);
  return new Decimal(fullMonths).plus(new Decimal(extraDays).dividedBy(dimCursor));
}

/**
 * Computes simple interest for a single due entry across any applicable rate changes.
 *
 * When the customer's interest rate changes over time:
 * - The OLD rate applies up to the effective date of the change.
 * - The NEW rate applies from the change onward.
 * - Past periods are never retroactively recalculated using the new rate.
 *
 * All interest amounts are strictly rounded to 2 decimal places with ROUND_HALF_UP.
 *
 * @param principalAmount - The due entry principal
 * @param startDate - Entry date (interest accrual start)
 * @param endDate - Calculation date (payment date or display date)
 * @param rateScheduleOrRate - Monthly interest rate in percent or array of dated rate changes
 * @param priorUnpaidInterest - Prior unpaid interest carried over from previous shortfall
 */
export function computeEntryInterest(
  principalAmount: Decimal,
  startDate: Date,
  endDate: Date,
  rateScheduleOrRate: RateSchedule,
  priorUnpaidInterest: Decimal = new Decimal(0),
): { interest: Decimal; monthsElapsed: Decimal; accruedInterest: Decimal } {
  const normPrior = priorUnpaidInterest.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const start = normalizeToUTCMidnight(startDate);
  const end = normalizeToUTCMidnight(endDate);

  if (principalAmount.lte(0) || end.getTime() <= start.getTime()) {
    return {
      interest: normPrior,
      monthsElapsed: new Decimal(0),
      accruedInterest: new Decimal(0),
    };
  }

  const schedule = normalizeRateSchedule(rateScheduleOrRate, start);
  const totalMonths = computeMonthsElapsed(start, end);

  // Find all rate change transition dates that fall strictly between start and end
  const transitionDates = schedule
    .map((r) => r.effectiveDate)
    .filter((d) => d.getTime() > start.getTime() && d.getTime() < end.getTime());

  // If no transition dates between start and end, a single rate applies across the full span
  if (transitionDates.length === 0) {
    const rate = getEffectiveRateAt(schedule, start);
    if (rate.lte(0)) {
      return {
        interest: normPrior,
        monthsElapsed: totalMonths,
        accruedInterest: new Decimal(0),
      };
    }
    const accruedInterest = principalAmount
      .times(rate.dividedBy(100))
      .times(totalMonths)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const totalInterest = accruedInterest.plus(normPrior);
    return {
      interest: totalInterest,
      monthsElapsed: totalMonths,
      accruedInterest,
    };
  }

  // Multiple segments between start and end:
  // De-duplicate and sort transition boundaries
  const uniqueTransitions = Array.from(new Set(transitionDates.map((d) => d.getTime())))
    .sort((a, b) => a - b)
    .map((t) => new Date(t));

  const boundaries = [start, ...uniqueTransitions, end];
  let totalAccrued = new Decimal(0);

  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    const segMonths = computeMonthsElapsed(segStart, segEnd);
    const segRate = getEffectiveRateAt(schedule, segStart);

    if (segRate.gt(0) && segMonths.gt(0)) {
      const segInterest = principalAmount.times(segRate.dividedBy(100)).times(segMonths);
      totalAccrued = totalAccrued.plus(segInterest);
    }
  }

  const accruedInterest = totalAccrued.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const totalInterest = accruedInterest.plus(normPrior);

  return {
    interest: totalInterest,
    monthsElapsed: totalMonths,
    accruedInterest,
  };
}

/**
 * Settles ALL open due entries against a payment.
 *
 * Follows the financial waterfall: Interest First, then Principal.
 *
 * - If payment < totalInterest:
 *   - Principal remains completely untouched!
 *   - Unpaid interest is tracked and carried over.
 *   - Consolidated due entry: { principalAmount = totalPrincipal, unpaidInterest = totalInterest - payment }.
 * - If totalInterest <= payment < totalOwed:
 *   - All interest is paid off.
 *   - Excess payment reduces principal.
 *   - Consolidated due entry: { principalAmount = totalPrincipal - (payment - totalInterest), unpaidInterest = 0 }.
 * - If payment >= totalOwed:
 *   - All interest and principal paid off.
 *   - Excess payment -> advance balance.
 *
 * @param dueEntries - All currently open due entries
 * @param paymentAmount - Payment amount (must be > 0)
 * @param paymentDate - Date of payment
 * @param rateScheduleOrRate - Per-customer monthly interest rate in percent or rate schedule
 */
export function computeSettlement(
  dueEntries: DueEntry[],
  paymentAmount: Decimal | number,
  paymentDate: Date,
  rateScheduleOrRate: RateSchedule,
): SettlementResult {
  const decPayment = new Decimal(paymentAmount);
  if (decPayment.lte(0)) {
    throw new InvalidAmountError('Payment amount must be greater than zero');
  }

  const normPaymentDate = normalizeToUTCMidnight(paymentDate);
  const settledEntries: SettledEntryResult[] = [];
  let totalPrincipal = new Decimal(0);
  let totalInterest = new Decimal(0);

  for (const entry of dueEntries) {
    const normEntryDate = normalizeToUTCMidnight(entry.date);
    if (normPaymentDate.getTime() < normEntryDate.getTime()) {
      throw new InvalidDateOrderError(
        `Payment date (${normPaymentDate.toISOString().slice(0, 10)}) cannot precede due entry date (${normEntryDate.toISOString().slice(0, 10)})`,
      );
    }

    const priorUnpaid = entry.unpaidInterest ?? new Decimal(0);
    const { interest, monthsElapsed } = computeEntryInterest(
      entry.principalAmount,
      normEntryDate,
      normPaymentDate,
      rateScheduleOrRate,
      priorUnpaid,
    );

    settledEntries.push({
      date: normEntryDate,
      principalAmount: entry.principalAmount,
      interestCharged: interest,
      monthsElapsed,
      originTransactionId: entry.originTransactionId,
      originPaymentId: entry.originPaymentId,
    });

    totalPrincipal = totalPrincipal.plus(entry.principalAmount);
    totalInterest = totalInterest.plus(interest);
  }

  const totalOwed = totalPrincipal.plus(totalInterest);
  const remaining = decPayment.minus(totalOwed);

  let newConsolidatedEntry: {
    date: Date;
    principalAmount: Decimal;
    unpaidInterest: Decimal;
  } | null = null;
  let remainingUnpaidInterest = new Decimal(0);

  if (remaining.isNegative()) {
    // Underpayment / Partial Payment
    if (decPayment.lt(totalInterest)) {
      // Payment covers ONLY partial interest: NO principal reduction
      remainingUnpaidInterest = totalInterest.minus(decPayment);
      newConsolidatedEntry = {
        date: normPaymentDate,
        principalAmount: totalPrincipal, // Principal remains 100% intact
        unpaidInterest: remainingUnpaidInterest,
      };
    } else {
      // Payment covers all interest and partially reduces principal
      const paymentTowardsPrincipal = decPayment.minus(totalInterest);
      const remainingPrincipal = totalPrincipal.minus(paymentTowardsPrincipal);
      newConsolidatedEntry = {
        date: normPaymentDate,
        principalAmount: remainingPrincipal,
        unpaidInterest: new Decimal(0),
      };
    }
  }

  return {
    settledEntries,
    totalPrincipal,
    totalInterest,
    totalOwed,
    remainingPayment: Decimal.max(remaining, new Decimal(0)),
    unpaidInterest: remainingUnpaidInterest,
    newConsolidatedEntry,
  };
}

/**
 * Processes a purchase (DEBIT) transaction.
 *
 * If advance >= amount: deduct from advance, no due entry.
 * If advance < amount: deduct advance, create due entry for shortfall.
 * If advance = 0: create due entry for full amount.
 *
 * Throws InvalidAmountError if amount <= 0.
 * Throws InvalidDateOrderError if date precedes lastProcessedDate.
 */
export function processPurchase(
  currentAdvance: Decimal,
  amount: Decimal | number,
  date: Date,
  transactionId: string,
  lastProcessedDate?: Date,
): PurchaseResult {
  const decAmount = new Decimal(amount);
  if (decAmount.lte(0)) {
    throw new InvalidAmountError('Amount must be greater than zero');
  }

  const normDate = normalizeToUTCMidnight(date);
  if (lastProcessedDate) {
    const normLast = normalizeToUTCMidnight(lastProcessedDate);
    if (normDate.getTime() < normLast.getTime()) {
      throw new InvalidDateOrderError(
        `Purchase date (${normDate.toISOString().slice(0, 10)}) cannot precede last processed date (${normLast.toISOString().slice(0, 10)})`,
      );
    }
  }

  if (currentAdvance.gt(0)) {
    if (currentAdvance.gte(decAmount)) {
      return {
        newAdvance: currentAdvance.minus(decAmount),
        newDueEntry: null,
        outstandingPrincipal: new Decimal(0),
        advanceUsed: decAmount,
      };
    }

    const shortfall = decAmount.minus(currentAdvance);
    return {
      newAdvance: new Decimal(0),
      newDueEntry: {
        date: normDate,
        principalAmount: shortfall,
        unpaidInterest: new Decimal(0),
        originTransactionId: transactionId,
        originPaymentId: null,
      },
      outstandingPrincipal: shortfall,
      advanceUsed: currentAdvance,
    };
  }

  return {
    newAdvance: new Decimal(0),
    newDueEntry: {
      date: normDate,
      principalAmount: decAmount,
      unpaidInterest: new Decimal(0),
      originTransactionId: transactionId,
      originPaymentId: null,
    },
    outstandingPrincipal: decAmount,
    advanceUsed: new Decimal(0),
  };
}

/**
 * Processes a payment (CREDIT) transaction.
 *
 * If due entries exist: settles all, computes interest, excess -> advance.
 * If no due entries: full amount -> advance.
 *
 * Throws InvalidAmountError if paymentAmount <= 0.
 * Throws InvalidDateOrderError if paymentDate precedes lastProcessedDate.
 */
export function processPayment(
  currentAdvance: Decimal,
  dueEntries: DueEntry[],
  paymentAmount: Decimal | number,
  paymentDate: Date | string,
  rateScheduleOrRate: RateSchedule,
  lastProcessedDate?: Date,
): PaymentResult {
  const decPayment = new Decimal(paymentAmount);
  if (decPayment.lte(0)) {
    throw new InvalidAmountError('Payment amount must be greater than zero');
  }

  const parsedDate =
    typeof paymentDate === 'string'
      ? new Date(paymentDate.includes('T') ? paymentDate : `${paymentDate}T00:00:00.000Z`)
      : paymentDate;
  const normDate = normalizeToUTCMidnight(parsedDate);
  if (lastProcessedDate) {
    const normLast = normalizeToUTCMidnight(lastProcessedDate);
    if (normDate.getTime() < normLast.getTime()) {
      throw new InvalidDateOrderError(
        `Payment date (${normDate.toISOString().slice(0, 10)}) cannot precede last processed date (${normLast.toISOString().slice(0, 10)})`,
      );
    }
  }

  if (dueEntries.length === 0) {
    const newAdv = currentAdvance.plus(decPayment);
    return {
      newAdvance: newAdv,
      settlement: null,
      interestSettled: 0,
      principalSettled: 0,
      advanceRemaining: newAdv.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
    };
  }

  const settlement = computeSettlement(dueEntries, decPayment, normDate, rateScheduleOrRate);

  const interestSettled = Decimal.min(decPayment, settlement.totalInterest)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
  const paymentAfterInterest = Decimal.max(0, decPayment.minus(settlement.totalInterest));
  const principalSettled = Decimal.min(paymentAfterInterest, settlement.totalPrincipal)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
  const newAdv = currentAdvance.plus(settlement.remainingPayment);

  return {
    newAdvance: newAdv,
    settlement,
    interestSettled,
    principalSettled,
    advanceRemaining: newAdv.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

/**
 * Computes the display balance status for a customer as of a given date.
 *
 * - Due entries exist -> "Due", amount = principal + accrued interest to asOfDate
 * - No due entries, advance > 0 -> "Advance", amount = advance
 * - Both zero -> "Settled", amount = 0
 */
export function getBalanceStatus(
  advance: Decimal,
  dueEntries: DueEntry[],
  asOfDate: Date,
  rateScheduleOrRate: RateSchedule,
): BalanceStatus {
  const normAsOf = normalizeToUTCMidnight(asOfDate);
  if (dueEntries.length > 0) {
    let totalPrincipal = new Decimal(0);
    let totalInterest = new Decimal(0);
    let totalUnpaidInterest = new Decimal(0);

    for (const entry of dueEntries) {
      totalPrincipal = totalPrincipal.plus(entry.principalAmount);
      const priorUnpaid = entry.unpaidInterest ?? new Decimal(0);
      totalUnpaidInterest = totalUnpaidInterest.plus(priorUnpaid);
      const { interest } = computeEntryInterest(
        entry.principalAmount,
        entry.date,
        normAsOf,
        rateScheduleOrRate,
        priorUnpaid,
      );
      totalInterest = totalInterest.plus(interest);
    }

    const displayAmount = totalPrincipal.plus(totalInterest);
    return {
      status: 'Due',
      displayAmount,
      totalPrincipal,
      totalInterest,
      totalDue: totalPrincipal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
      advance: 0,
      accruedInterest: totalInterest.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
      unpaidInterest: totalUnpaidInterest.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
    };
  }

  if (advance.gt(0)) {
    const advNum = advance.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    return {
      status: 'Advance',
      displayAmount: advance,
      totalPrincipal: new Decimal(0),
      totalInterest: new Decimal(0),
      totalDue: 0,
      advance: advNum,
      accruedInterest: 0,
      unpaidInterest: 0,
    };
  }

  return {
    status: 'Settled',
    displayAmount: new Decimal(0),
    totalPrincipal: new Decimal(0),
    totalInterest: new Decimal(0),
    totalDue: 0,
    advance: 0,
    accruedInterest: 0,
    unpaidInterest: 0,
  };
}

/**
 * Replays a sequence of transactions chronologically through the Due/Advance engine.
 *
 * Deterministic Sorting Rules:
 * 1. Normalized UTC Midnight Date (ascending)
 * 2. On same day: CREDIT (Payment) before DEBIT (Purchase) so advance is formed first
 * 3. createdAt (ascending)
 * 4. Transaction ID (lexicographical)
 *
 * @param events - Transaction events to replay (sorted deterministically internally)
 * @param rateScheduleOrRate - Monthly interest rate in percent or full rate schedule
 * @returns Complete replay state after all events
 */
export function replayTransactions(
  events: TransactionEvent[],
  rateScheduleOrRate: RateSchedule,
): ReplayState {
  let advance = new Decimal(0);
  let openDueEntries: DueEntry[] = [];
  const settledHistory: SettlementRecord[] = [];
  const advanceUsageByTransaction = new Map<string, AdvanceUsageRecord>();

  // Deterministic chronological sort
  const sortedEvents = [...events].sort((a, b) => {
    const dateA = normalizeToUTCMidnight(a.date).getTime();
    const dateB = normalizeToUTCMidnight(b.date).getTime();
    if (dateA !== dateB) return dateA - dateB;

    // On same day: CREDIT (payment) before DEBIT (purchase)
    if (a.type !== b.type) {
      return a.type === 'CREDIT' ? -1 : 1;
    }

    if (a.createdAt && b.createdAt) {
      const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (createdDiff !== 0) return createdDiff;
    }
    return a.id.localeCompare(b.id);
  });

  for (const event of sortedEvents) {
    if (event.type === 'DEBIT') {
      const result = processPurchase(advance, event.amount, event.date, event.id);
      advance = result.newAdvance;

      advanceUsageByTransaction.set(event.id, {
        transactionId: event.id,
        advanceUsed: result.advanceUsed,
        outstandingPrincipal: result.outstandingPrincipal,
      });

      if (result.newDueEntry) {
        openDueEntries.push(result.newDueEntry);
      }
    } else {
      // CREDIT (payment)
      const result = processPayment(
        advance,
        openDueEntries,
        event.amount,
        event.date,
        rateScheduleOrRate,
      );
      advance = result.newAdvance;

      if (result.settlement) {
        // Record settlement history for each settled entry
        for (const settled of result.settlement.settledEntries) {
          settledHistory.push({
            entryDate: settled.date,
            entryPrincipal: settled.principalAmount,
            entryOriginTransactionId: settled.originTransactionId,
            entryOriginPaymentId: settled.originPaymentId,
            interestCharged: settled.interestCharged,
            monthsElapsed: settled.monthsElapsed,
            settledByPaymentId: event.id,
            settledAt: normalizeToUTCMidnight(event.date),
          });
        }

        // Clear all open entries (they've all been settled)
        openDueEntries = [];

        // If shortfall, add consolidated entry to open due entries
        if (result.settlement.newConsolidatedEntry) {
          openDueEntries.push({
            date: result.settlement.newConsolidatedEntry.date,
            principalAmount: result.settlement.newConsolidatedEntry.principalAmount,
            unpaidInterest: result.settlement.newConsolidatedEntry.unpaidInterest,
            originTransactionId: null,
            originPaymentId: event.id,
          });
        }
      }
    }
  }

  return {
    advance,
    openDueEntries,
    settledHistory,
    advanceUsageByTransaction,
  };
}

/**
 * Stateful Due/Advance Engine class.
 *
 * Maintains customer state across sequential operations and guarantees:
 * - Chronological sequence enforcement (throws ChronologyError if out-of-order)
 * - Negative amount rejection
 * - Same-day transaction handling
 * - Flexible input formats (objects `{ date, amount }` or positional args)
 */
export class DueAdvanceEngine {
  public advance: Decimal = new Decimal(0);
  public openDueEntries: DueEntry[] = [];
  public settledHistory: SettlementRecord[] = [];
  public advanceUsageByTransaction = new Map<string, AdvanceUsageRecord>();
  public lastProcessedDate: Date | null = null;
  public rateSchedule: RateChange[] = [];
  public monthlyRatePercent: Decimal;

  constructor(configOrRate: DueAdvanceEngineConfig | number | Decimal | RateChange[] = 2) {
    if (Array.isArray(configOrRate)) {
      this.rateSchedule = normalizeRateSchedule(configOrRate);
      this.monthlyRatePercent = this.rateSchedule[this.rateSchedule.length - 1].monthlyRatePercent;
    } else if (typeof configOrRate === 'object' && !(configOrRate instanceof Decimal)) {
      if (configOrRate.monthlyInterestRate !== undefined) {
        const r = new Decimal(configOrRate.monthlyInterestRate);
        this.monthlyRatePercent = r.lte(0.1) && r.gt(0) ? r.times(100) : r;
      } else if (configOrRate.monthlyRatePercent !== undefined) {
        this.monthlyRatePercent = new Decimal(configOrRate.monthlyRatePercent);
      } else {
        this.monthlyRatePercent = new Decimal(2);
      }
      this.rateSchedule = [
        { effectiveDate: new Date(0), monthlyRatePercent: this.monthlyRatePercent },
      ];
    } else {
      const r = new Decimal(configOrRate);
      this.monthlyRatePercent = r.lte(0.1) && r.gt(0) ? r.times(100) : r;
      this.rateSchedule = [
        { effectiveDate: new Date(0), monthlyRatePercent: this.monthlyRatePercent },
      ];
    }
  }

  /**
   * Sets a new interest rate effective from a specified date onward.
   * Does NOT retroactively affect periods prior to effectiveDate.
   */
  public setRate(newRate: number | Decimal, effectiveDate: Date | string = new Date()): void {
    const rateDec = new Decimal(newRate);
    const parsedDate =
      typeof effectiveDate === 'string'
        ? new Date(effectiveDate.includes('T') ? effectiveDate : `${effectiveDate}T00:00:00.000Z`)
        : effectiveDate;
    const normDate = normalizeToUTCMidnight(parsedDate);
    const normalizedNewRate = rateDec.lte(0.1) && rateDec.gt(0) ? rateDec.times(100) : rateDec;
    this.rateSchedule.push({
      effectiveDate: normDate,
      monthlyRatePercent: normalizedNewRate,
    });
    this.rateSchedule = normalizeRateSchedule(this.rateSchedule);
    this.monthlyRatePercent = this.rateSchedule[this.rateSchedule.length - 1].monthlyRatePercent;
  }

  public processPurchase(
    paramsOrAmount:
      { date: string | Date; amount: Decimal | number; id?: string } | Decimal | number,
    date?: string | Date,
    transactionId: string = 'tx',
  ): PurchaseResult {
    let amount: Decimal | number;
    let rawDate: string | Date;
    let txId: string;

    if (typeof paramsOrAmount === 'object' && !(paramsOrAmount instanceof Decimal)) {
      amount = paramsOrAmount.amount;
      rawDate = paramsOrAmount.date;
      txId = paramsOrAmount.id || transactionId;
    } else {
      amount = paramsOrAmount;
      rawDate = date!;
      txId = transactionId;
    }

    const parsedDate =
      typeof rawDate === 'string'
        ? new Date(rawDate.includes('T') ? rawDate : `${rawDate}T00:00:00.000Z`)
        : rawDate;
    const normDate = normalizeToUTCMidnight(parsedDate);

    if (this.lastProcessedDate && normDate.getTime() < this.lastProcessedDate.getTime()) {
      throw new InvalidDateOrderError(
        `Cannot process purchase on ${normDate.toISOString().slice(0, 10)} after already processing transactions up to ${this.lastProcessedDate.toISOString().slice(0, 10)}`,
      );
    }

    const result = processPurchase(
      this.advance,
      amount,
      normDate,
      txId,
      this.lastProcessedDate ?? undefined,
    );
    this.advance = result.newAdvance;
    this.advanceUsageByTransaction.set(txId, {
      transactionId: txId,
      advanceUsed: result.advanceUsed,
      outstandingPrincipal: result.outstandingPrincipal,
    });
    if (result.newDueEntry) {
      this.openDueEntries.push(result.newDueEntry);
    }
    this.lastProcessedDate = normDate;
    return result;
  }

  public processPayment(
    paramsOrAmount:
      { date: string | Date; amount: Decimal | number; id?: string } | Decimal | number,
    date?: string | Date,
    paymentId: string = 'pay',
  ): PaymentResult {
    let amount: Decimal | number;
    let rawDate: string | Date;
    let payId: string;

    if (typeof paramsOrAmount === 'object' && !(paramsOrAmount instanceof Decimal)) {
      amount = paramsOrAmount.amount;
      rawDate = paramsOrAmount.date;
      payId = paramsOrAmount.id || paymentId;
    } else {
      amount = paramsOrAmount;
      rawDate = date!;
      payId = paymentId;
    }

    const parsedDate =
      typeof rawDate === 'string'
        ? new Date(rawDate.includes('T') ? rawDate : `${rawDate}T00:00:00.000Z`)
        : rawDate;
    const normDate = normalizeToUTCMidnight(parsedDate);

    if (this.lastProcessedDate && normDate.getTime() < this.lastProcessedDate.getTime()) {
      throw new InvalidDateOrderError(
        `Cannot process payment on ${normDate.toISOString().slice(0, 10)} after already processing transactions up to ${this.lastProcessedDate.toISOString().slice(0, 10)}`,
      );
    }

    const result = processPayment(
      this.advance,
      this.openDueEntries,
      amount,
      normDate,
      this.rateSchedule,
      this.lastProcessedDate ?? undefined,
    );
    this.advance = result.newAdvance;

    if (result.settlement) {
      for (const settled of result.settlement.settledEntries) {
        this.settledHistory.push({
          entryDate: settled.date,
          entryPrincipal: settled.principalAmount,
          entryOriginTransactionId: settled.originTransactionId,
          entryOriginPaymentId: settled.originPaymentId,
          interestCharged: settled.interestCharged,
          monthsElapsed: settled.monthsElapsed,
          settledByPaymentId: payId,
          settledAt: normDate,
        });
      }

      this.openDueEntries = [];
      if (result.settlement.newConsolidatedEntry) {
        this.openDueEntries.push({
          date: result.settlement.newConsolidatedEntry.date,
          principalAmount: result.settlement.newConsolidatedEntry.principalAmount,
          unpaidInterest: result.settlement.newConsolidatedEntry.unpaidInterest,
          originTransactionId: null,
          originPaymentId: payId,
        });
      }
    }

    this.lastProcessedDate = normDate;
    return result;
  }

  public getBalanceStatus(asOfDate: string | Date = new Date()): BalanceStatus {
    const parsedDate =
      typeof asOfDate === 'string'
        ? new Date(asOfDate.includes('T') ? asOfDate : `${asOfDate}T00:00:00.000Z`)
        : asOfDate;
    return getBalanceStatus(this.advance, this.openDueEntries, parsedDate, this.rateSchedule);
  }
}
