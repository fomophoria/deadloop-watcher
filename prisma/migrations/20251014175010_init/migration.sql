-- CreateTable
CREATE TABLE "Burn" (
    "id" SERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "tokenAddress" TEXT,
    "amountRaw" TEXT,
    "amountHuman" DECIMAL(65,30),
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Burn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Burn_txHash_key" ON "Burn"("txHash");

-- CreateIndex
CREATE INDEX "Burn_timestamp_idx" ON "Burn"("timestamp");

-- CreateIndex
CREATE INDEX "Burn_tokenAddress_idx" ON "Burn"("tokenAddress");
