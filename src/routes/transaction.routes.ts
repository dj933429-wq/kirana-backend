import { Router } from 'express';
import { TransactionController } from '../controllers/transaction.controller';
import { validateCreateTransaction } from '../middleware/transactionValidation.middleware';
import { validateParams, uuidParamSchema } from '../middleware/validation.middleware';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new TransactionController();

// Protect all transaction routes
router.use(authMiddleware);

/**
 * Create Transaction
 * POST /api/v1/transactions
 */
router.post('/', validateCreateTransaction, controller.createTransaction);

/**
 * Get Transaction by ID
 * GET /api/v1/transactions/:id
 */
router.get('/:id', validateParams(uuidParamSchema), controller.getTransaction);

/**
 * Void Transaction
 * PATCH /api/v1/transactions/:id/void
 */
router.patch('/:id/void', validateParams(uuidParamSchema), controller.voidTransaction);

export default router;
