import { prisma } from '../config/database';
import { CompoundingFrequency, Customer } from '../generated/prisma/client';
import { AppError } from '../middleware/errorHandler';
import { LedgerService } from './ledger.service';

export interface CreateCustomerInput {
  name: string;
  phoneNumber: string;
  lendingRate: number;
  depositRate: number;
  compoundingFrequency: CompoundingFrequency;
  interestRate?: number;
}

export interface UpdateCustomerInput {
  name?: string;
  phoneNumber?: string;
  lendingRate?: number;
  depositRate?: number;
  compoundingFrequency?: CompoundingFrequency;
  interestRate?: number;
  effectiveDate?: Date | string;
}

export interface PaginationParams {
  page: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  customers: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

export class CustomerService {
  /**
   * Creates a new customer for a merchant.
   * Ensures the phone number is unique within the merchant's scope.
   */
  public async createCustomer(userId: string, data: CreateCustomerInput): Promise<Customer> {
    const existing = await prisma.customer.findFirst({
      where: {
        userId,
        phoneNumber: data.phoneNumber,
      },
    });

    if (existing) {
      throw new AppError('Customer with this phone number already exists for this merchant.', 400);
    }

    const customer = await prisma.customer.create({
      data: {
        userId,
        name: data.name,
        phoneNumber: data.phoneNumber,
        lendingRate: data.lendingRate,
        depositRate: data.depositRate,
        compoundingFrequency: data.compoundingFrequency,
        interestRate: data.interestRate ?? 0,
        isActive: true,
      },
    });

    // Record initial interest rate history
    await prisma.customerInterestRate.create({
      data: {
        customerId: customer.id,
        interestRate: data.interestRate ?? 0,
        effectiveDate: customer.createdAt,
      },
    });

    return customer;
  }

  /**
   * Retrieves an active customer by ID.
   * Throws 404 if not found or archived.
   */
  public async getCustomerById(userId: string, id: string): Promise<Customer> {
    const customer = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customer) {
      throw new AppError('Customer not found.', 404);
    }

    return customer;
  }

  /**
   * Retrieves all active customers for a merchant (paginated and sorted).
   */
  public async getAllCustomers(
    userId: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<Customer>> {
    const { page, limit, sort, order } = params;
    const skip = (page - 1) * limit;
    const take = limit;
    const orderBy = { [sort]: order };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where: {
          userId,
          isActive: true,
        },
        skip,
        take,
        orderBy,
      }),
      prisma.customer.count({
        where: {
          userId,
          isActive: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      customers,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    };
  }

  /**
   * Searches active customers by name or phone number (paginated and sorted).
   */
  public async searchCustomers(
    userId: string,
    query: string,
    params: PaginationParams,
  ): Promise<PaginatedResult<Customer>> {
    const { page, limit, sort, order } = params;
    const skip = (page - 1) * limit;
    const take = limit;
    const orderBy = { [sort]: order };

    const searchCondition = {
      userId,
      isActive: true,
      OR: [
        { name: { contains: query, mode: 'insensitive' as const } },
        { phoneNumber: { contains: query } },
      ],
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where: searchCondition,
        skip,
        take,
        orderBy,
      }),
      prisma.customer.count({
        where: searchCondition,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      customers,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    };
  }

  /**
   * Updates an existing active customer.
   * Ensures the phone number is not taken by another customer of the same merchant.
   */
  public async updateCustomer(
    userId: string,
    id: string,
    data: UpdateCustomerInput,
  ): Promise<Customer> {
    const customer = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customer) {
      throw new AppError('Customer not found.', 404);
    }

    if (data.phoneNumber && data.phoneNumber !== customer.phoneNumber) {
      const duplicate = await prisma.customer.findFirst({
        where: {
          userId,
          phoneNumber: data.phoneNumber,
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new AppError(
          'Customer with this phone number already exists for this merchant.',
          400,
        );
      }
    }

    // If interest rate is provided and differs from customer.interestRate
    const isRateChanged =
      data.interestRate !== undefined &&
      Number(data.interestRate) !== Number(customer.interestRate);

    if (isRateChanged) {
      const parsedEffective = data.effectiveDate ? new Date(data.effectiveDate) : new Date();
      await prisma.customerInterestRate.create({
        data: {
          customerId: id,
          interestRate: data.interestRate!,
          effectiveDate: parsedEffective,
        },
      });
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: {
        name: data.name,
        phoneNumber: data.phoneNumber,
        lendingRate: data.lendingRate,
        depositRate: data.depositRate,
        compoundingFrequency: data.compoundingFrequency,
        interestRate: data.interestRate,
      },
    });

    if (isRateChanged) {
      const ledgerService = new LedgerService();
      await ledgerService.reconcileCustomerLedger(id);
    }

    return updated;
  }

  /**
   * Archives (soft-deletes) a customer by setting isActive to false.
   */
  public async archiveCustomer(userId: string, id: string): Promise<Customer> {
    const customer = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customer) {
      throw new AppError('Customer not found.', 404);
    }

    return prisma.customer.update({
      where: { id },
      data: {
        isActive: false,
      },
    });
  }
}
