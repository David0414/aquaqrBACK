ALTER TABLE "Wallet"
ADD COLUMN "bonusBalanceCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "location" TEXT,
    "address" TEXT,
    "hardwareId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppPromotion" (
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppPromotion_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "RewardCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promotionKey" TEXT NOT NULL,
    "externalId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardCredit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Machine_isActive_idx" ON "Machine"("isActive");
CREATE INDEX "Machine_hardwareId_idx" ON "Machine"("hardwareId");
CREATE INDEX "AppPromotion_sortOrder_idx" ON "AppPromotion"("sortOrder");
CREATE INDEX "AppPromotion_isActive_idx" ON "AppPromotion"("isActive");
CREATE UNIQUE INDEX "RewardCredit_externalId_key" ON "RewardCredit"("externalId");
CREATE INDEX "RewardCredit_userId_createdAt_idx" ON "RewardCredit"("userId", "createdAt");
CREATE INDEX "RewardCredit_promotionKey_createdAt_idx" ON "RewardCredit"("promotionKey", "createdAt");

ALTER TABLE "RewardCredit"
ADD CONSTRAINT "RewardCredit_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
