-- CreateTable
CREATE TABLE "customer_interest_rates" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "interest_rate" DECIMAL(5,2) NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_interest_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_interest_rates_customer_id_idx" ON "customer_interest_rates"("customer_id");

-- CreateIndex
CREATE INDEX "customer_interest_rates_effective_date_idx" ON "customer_interest_rates"("effective_date");

-- AddForeignKey
ALTER TABLE "customer_interest_rates" ADD CONSTRAINT "customer_interest_rates_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
