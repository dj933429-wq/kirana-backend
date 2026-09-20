import { Request, Response, NextFunction } from 'express';
import { z, Schema } from 'zod';

// Shared phone validator: trims, ensures only digits, and requires exactly 10 digits
const phoneValidator = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => /^\d+$/.test(val), {
    message: 'Phone number must contain only digits',
  })
  .refine((val) => val.length === 10, {
    message: 'Phone number must be exactly 10 digits',
  });

export const createCustomerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(100, 'Name must be less than 100 characters'),
    phoneNumber: phoneValidator,
    lendingRate: z.coerce
      .number()
      .min(0, 'Lending rate cannot be negative')
      .max(100, 'Lending rate cannot exceed 100%'),
    depositRate: z.coerce
      .number()
      .min(0, 'Deposit rate cannot be negative')
      .max(100, 'Deposit rate cannot exceed 100%'),
    defaultInterestType: z.enum(['NO_INTEREST', 'SIMPLE', 'COMPOUND']).default('SIMPLE'),
    compoundingFrequency: z
      .enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM'])
      .default('MONTHLY'),
    customCompoundDays: z.coerce
      .number()
      .int('Custom compound days must be an integer')
      .positive('Custom compound days must be greater than zero')
      .optional(),
    interestRate: z.coerce
      .number()
      .min(0, 'Interest rate cannot be negative')
      .max(100, 'Interest rate cannot exceed 100%')
      .default(0),
  })
  .refine(
    (data) => {
      if (data.compoundingFrequency === 'CUSTOM') {
        return !!data.customCompoundDays && data.customCompoundDays > 0;
      }
      return true;
    },
    {
      message: 'customCompoundDays is required when compounding frequency is CUSTOM',
      path: ['customCompoundDays'],
    },
  );

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const updateCustomerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name cannot be empty')
      .max(100, 'Name must be less than 100 characters')
      .optional(),
    phoneNumber: phoneValidator.optional(),
    lendingRate: z.coerce
      .number()
      .min(0, 'Lending rate cannot be negative')
      .max(100, 'Lending rate cannot exceed 100%')
      .optional(),
    depositRate: z.coerce
      .number()
      .min(0, 'Deposit rate cannot be negative')
      .max(100, 'Deposit rate cannot exceed 100%')
      .optional(),
    defaultInterestType: z.enum(['NO_INTEREST', 'SIMPLE', 'COMPOUND']).optional(),
    compoundingFrequency: z
      .enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM'])
      .optional(),
    customCompoundDays: z.coerce
      .number()
      .int('Custom compound days must be an integer')
      .positive('Custom compound days must be greater than zero')
      .optional(),
    interestRate: z.coerce
      .number()
      .min(0, 'Interest rate cannot be negative')
      .max(100, 'Interest rate cannot exceed 100%')
      .optional(),
    effectiveDate: z.coerce.date().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  })
  .refine(
    (data) => {
      if (data.compoundingFrequency === 'CUSTOM') {
        return !!data.customCompoundDays && data.customCompoundDays > 0;
      }
      return true;
    },
    {
      message: 'customCompoundDays is required when compounding frequency is CUSTOM',
      path: ['customCompoundDays'],
    },
  );

const allowedSortFields = [
  'name',
  'phoneNumber',
  'lendingRate',
  'depositRate',
  'defaultInterestType',
  'compoundingFrequency',
  'createdAt',
  'updatedAt',
];

export const paginationAndSortSchema = z.object({
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
  sort: z
    .string()
    .refine((val) => allowedSortFields.includes(val), {
      message: `Sort field must be one of: ${allowedSortFields.join(', ')}`,
    })
    .default('name'),
  order: z
    .enum(['asc', 'desc'], {
      message: 'Order must be asc or desc',
    })
    .default('asc'),
});

export const searchCustomersSchema = paginationAndSortSchema.extend({
  q: z.string().default(''),
});

/**
 * Reusable body validation middleware
 */
export const validateBody = (schema: Schema) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
};

/**
 * Reusable query validation middleware
 */
export const validateQuery = (schema: Schema) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.query);
      Object.defineProperty(req, 'query', {
        value: parsed,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
};

export const ledgerQuerySchema = z.object({
  calculationDate: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid date format',
    })
    .optional(),
});
