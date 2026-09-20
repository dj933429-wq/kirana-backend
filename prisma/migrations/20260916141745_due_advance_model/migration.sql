-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "advance_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "interest_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ALTER COLUMN "compounding_frequency" SET DEFAULT 'MONTHLY';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "created_by_payment_id" TEXT,
ADD COLUMN     "interest_charged" DECIMAL(12,2),
ADD COLUMN     "is_settled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_system_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outstanding_principal" DECIMAL(12,2),
ADD COLUMN     "settled_at" TIMESTAMP(3),
ADD COLUMN     "settled_by_payment_id" TEXT;

-- CreateIndex
CREATE INDEX "transactions_is_settled_idx" ON "transactions"("is_settled");

-- CreateIndex
CREATE INDEX "transactions_settled_by_payment_id_idx" ON "transactions"("settled_by_payment_id");

-- CreateIndex
CREATE INDEX "transactions_created_by_payment_id_idx" ON "transactions"("created_by_payment_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settled_by_payment_id_fkey" FOREIGN KEY ("settled_by_payment_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_payment_id_fkey" FOREIGN KEY ("created_by_payment_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
