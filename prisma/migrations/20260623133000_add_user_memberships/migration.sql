CREATE TABLE IF NOT EXISTS "UserMembership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "promotionKey" TEXT NOT NULL,
  "garrafonesTotal" DOUBLE PRECISION NOT NULL,
  "garrafonesRemaining" DOUBLE PRECISION NOT NULL,
  "litersTotal" DOUBLE PRECISION NOT NULL,
  "litersRemaining" DOUBLE PRECISION NOT NULL,
  "pricePaidCents" INTEGER NOT NULL,
  "pricePerGarrafonCents" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserMembership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "UserMembership_userId_expiresAt_idx"
ON "UserMembership"("userId", "expiresAt");

CREATE INDEX IF NOT EXISTS "UserMembership_promotionKey_status_idx"
ON "UserMembership"("promotionKey", "status");
