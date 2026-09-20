import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller';
import { TransactionController } from '../controllers/transaction.controller';
import { LedgerController } from '../controllers/ledger.controller';
import {
  validateBody,
  validateQuery,
  validateParams,
  createCustomerSchema,
  updateCustomerSchema,
  paginationAndSortSchema,
  searchCustomersSchema,
  ledgerQuerySchema,
  uuidParamSchema,
  customerIdParamSchema,
} from '../middleware/validation.middleware';
import { validateListTransactions } from '../middleware/transactionValidation.middleware';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new CustomerController();

// Protect all customer routes
router.use(authMiddleware);

// Create customer
router.post('/', validateBody(createCustomerSchema), controller.createCustomer);

// Search customers - placed before /:id to avoid ID conflict
router.get('/search', validateQuery(searchCustomersSchema), controller.searchCustomers);

// Get all customers
router.get('/', validateQuery(paginationAndSortSchema), controller.getAllCustomers);

// Get customer by ID
router.get('/:id', validateParams(uuidParamSchema), controller.getCustomer);

// Update customer
router.patch(
  '/:id',
  validateParams(uuidParamSchema),
  validateBody(updateCustomerSchema),
  controller.updateCustomer,
);

// Soft delete customer
router.delete('/:id', validateParams(uuidParamSchema), controller.deleteCustomer);

const transactionController = new TransactionController();
const ledgerController = new LedgerController();

// Get customer transactions
router.get(
  '/:customerId/transactions',
  validateParams(customerIdParamSchema),
  validateListTransactions,
  transactionController.getCustomerTransactions,
);

// Get customer ledger with dynamic interest
router.get(
  '/:customerId/ledger',
  validateParams(customerIdParamSchema),
  validateQuery(ledgerQuerySchema),
  ledgerController.getCustomerLedger,
);

export default router;
