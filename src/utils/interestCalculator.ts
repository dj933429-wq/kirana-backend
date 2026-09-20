export type InterestType = 'NO_INTEREST' | 'SIMPLE' | 'COMPOUND';

export type CompoundingFrequency =
  'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY' | 'CUSTOM';

export interface InterestCalculatorInput {
  principal: number;
  annualInterestRate?: number;
  startDate: Date | string;
  calculationDate: Date | string;
  interestType?: InterestType;
  compoundingFrequency?: CompoundingFrequency;
  customCompoundDays?: number | null;
}

export interface InterestCalculatorOutput {
  elapsedDays: number;
  elapsedYears: number;
  interest: number;
  totalAmount: number;
}

/**
 * Calculates interest based on financial rules for:
 * 1. NO_INTEREST: Returns 0 interest
 * 2. SIMPLE: Interest = (Principal * AnnualRate * elapsedDays) / (100 * 365)
 * 3. COMPOUND: A = P * (1 + r/n)^(n * t)
 */
export function calculateInterest(input: InterestCalculatorInput): InterestCalculatorOutput {
  const {
    principal,
    annualInterestRate = 0,
    startDate,
    calculationDate,
    interestType = 'COMPOUND',
    compoundingFrequency = 'MONTHLY',
    customCompoundDays,
  } = input;

  const d1 = new Date(startDate);
  d1.setUTCHours(0, 0, 0, 0);
  const d2 = new Date(calculationDate);
  d2.setUTCHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const elapsedDays = Math.max(0, Math.floor((d2.getTime() - d1.getTime()) / msPerDay));
  const elapsedYears = elapsedDays / 365.0;

  // Zero checks or NO_INTEREST
  if (
    principal <= 0 ||
    elapsedDays <= 0 ||
    interestType === 'NO_INTEREST' ||
    annualInterestRate <= 0
  ) {
    return {
      elapsedDays,
      elapsedYears,
      interest: 0,
      totalAmount: Math.round((principal + Number.EPSILON) * 100) / 100,
    };
  }

  // SIMPLE INTEREST
  if (interestType === 'SIMPLE') {
    const interest = (principal * annualInterestRate * elapsedDays) / (100.0 * 365.0);
    const roundedInterest = Math.round((interest + Number.EPSILON) * 100) / 100;
    return {
      elapsedDays,
      elapsedYears,
      interest: roundedInterest,
      totalAmount: Math.round((principal + roundedInterest + Number.EPSILON) * 100) / 100,
    };
  }

  // COMPOUND INTEREST
  let n = 12; // default MONTHLY
  switch (compoundingFrequency) {
    case 'DAILY':
      n = 365;
      break;
    case 'WEEKLY':
      n = 52;
      break;
    case 'MONTHLY':
      n = 12;
      break;
    case 'QUARTERLY':
      n = 4;
      break;
    case 'HALF_YEARLY':
      n = 2;
      break;
    case 'YEARLY':
      n = 1;
      break;
    case 'CUSTOM':
      if (customCompoundDays && customCompoundDays > 0) {
        n = 365.0 / customCompoundDays;
      } else {
        n = 12; // fallback
      }
      break;
  }

  const ratePerPeriod = annualInterestRate / 100.0 / n;
  const totalPeriods = n * elapsedYears;
  const totalAmount = principal * Math.pow(1 + ratePerPeriod, totalPeriods);
  const interest = totalAmount - principal;
  const roundedInterest = Math.round((interest + Number.EPSILON) * 100) / 100;

  return {
    elapsedDays,
    elapsedYears,
    interest: roundedInterest,
    totalAmount: Math.round((principal + roundedInterest + Number.EPSILON) * 100) / 100,
  };
}
