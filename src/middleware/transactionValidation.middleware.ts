import { z } from 'zod';
import { validateBody, validateQuery } from './validation.middleware';

/**
 * Zod schema for creating a new ledger transaction.
 */
export const createTransactionSchema = z
  .object({
    customerId: z.string().uuid('Invalid customer ID format'),
    type: z.enum(['DEBIT', 'CREDIT'], {
      message: 'Transaction type must be DEBIT or CREDIT',
    }),
    amount: z.coerce
      .number()
      .positive('Amount must be greater than zero')
      .max(99999999999.99, 'Amount cannot exceed maximum transaction limit')
      .refine(
        (val) => {
          const strVal = val.toString();
          const dotIdx = strVal.indexOf('.');
          if (dotIdx !== -1) {
            const decimalPart = strVal.slice(dotIdx + 1);
            if (decimalPart.includes('e')) return false; // Reject scientific notation formats
            return decimalPart.length <= 2;
          }
          return true;
        },
        { message: 'Amount cannot have more than 2 decimal places' },
      ),
    date: z.coerce.date().refine((d) => d <= new Date(), {
      message: 'Transaction date cannot be in the future',
    }),
    interestStartDate: z.coerce.date().refine((d) => d <= new Date(), {
      message: 'Interest start date cannot be in the future',
    }),
    interestType: z.enum(['NO_INTEREST', 'SIMPLE', 'COMPOUND']).optional().nullable(),
    interestRate: z.coerce
      .number()
      .min(0, 'Interest rate cannot be negative')
      .max(100, 'Interest rate cannot exceed 100%')
      .refine(
        (val) => {
          const strVal = val.toString();
          const dotIdx = strVal.indexOf('.');
          if (dotIdx !== -1) {
            const decimalPart = strVal.slice(dotIdx + 1);
            if (decimalPart.includes('e')) return false;
            return decimalPart.length <= 2;
          }
          return true;
        },
        { message: 'Interest rate cannot have more than 2 decimal places' },
      )
      .optional()
      .nullable(),
    compoundingFrequency: z
      .enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM'])
      .optional()
      .nullable(),
    customCompoundDays: z.coerce
      .number()
      .int('Custom compound days must be an integer')
      .positive('Custom compound days must be greater than zero')
      .optional()
      .nullable(),
    dueDate: z.coerce.date().optional().nullable(),
    targetEntryId: z.string().uuid('Invalid target entry ID format').optional().nullable(),
    remarks: z
      .string()
      .max(500, 'Remarks cannot exceed 500 characters')
      .transform((val) => val.trim())
      .optional()
      .nullable(),
  })
  .refine((data) => data.interestStartDate >= data.date, {
    message: 'Interest start date cannot be before the transaction date',
    path: ['interestStartDate'],
  })
  .refine(
    (data) => {
      if (data.dueDate && data.date) {
        return data.dueDate >= data.date;
      }
      return true;
    },
    {
      message: 'Due date cannot be before the transaction date',
      path: ['dueDate'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'DEBIT') {
        return data.targetEntryId === undefined || data.targetEntryId === null;
      }
      return true;
    },
    {
      message: 'Target entry ID is only allowed for CREDIT transactions',
      path: ['targetEntryId'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'CREDIT') {
        return data.interestType === undefined || data.interestType === null;
      }
      return true;
    },
    {
      message: 'Interest configuration is not allowed for CREDIT transactions',
      path: ['interestType'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'CREDIT') {
        return data.interestRate === undefined || data.interestRate === null;
      }
      return true;
    },
    {
      message: 'Interest rate is not allowed for CREDIT transactions',
      path: ['interestRate'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'CREDIT') {
        return data.compoundingFrequency === undefined || data.compoundingFrequency === null;
      }
      return true;
    },
    {
      message: 'Compounding frequency is not allowed for CREDIT transactions',
      path: ['compoundingFrequency'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'CREDIT') {
        return data.customCompoundDays === undefined || data.customCompoundDays === null;
      }
      return true;
    },
    {
      message: 'Custom compound days is not allowed for CREDIT transactions',
      path: ['customCompoundDays'],
    },
  )
  .refine(
    (data) => {
      if (data.type === 'DEBIT' && data.compoundingFrequency === 'CUSTOM') {
        return !!data.customCompoundDays && data.customCompoundDays > 0;
      }
      return true;
    },
    {
      message: 'customCompoundDays is required when compounding frequency is CUSTOM',
      path: ['customCompoundDays'],
    },
  );

/**
 * Zod schema for listing/searching transactions with pagination, sorting, and filters.
 */
export const listTransactionsSchema = z
  .object({
    page: z.coerce
      .number()
      .int('Page must be an integer')
      .min(1, 'Page must be at least 1')
      .default(1),
    limit: z.coerce
      .number()
      .int('Limit must be an integer')
      .min(1, 'Limit must be at least 1')
      .max(100, 'Limit cannot exceed 100')
      .default(20),
    sort: z.enum(['date', 'amount', 'interestStartDate', 'dueDate', 'createdAt']).default('date'),
    order: z.enum(['asc', 'desc']).default('desc'),
    type: z.enum(['DEBIT', 'CREDIT']).optional(),
    isVoided: z.enum(['true', 'false', 'all']).default('false'),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.endDate >= data.startDate;
      }
      return true;
    },
    {
      message: 'End date cannot be before start date',
      path: ['endDate'],
    },
  );

/**
 * Validation middlewares
 */
export const validateCreateTransaction = validateBody(createTransactionSchema);
export const validateListTransactions = validateQuery(listTransactionsSchema);
