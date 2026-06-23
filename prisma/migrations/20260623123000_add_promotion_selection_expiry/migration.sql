ALTER TABLE "UserPromotionSelection"
ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "UserPromotionSelection"
SET "expiresAt" = "createdAt" + INTERVAL '30 days'
WHERE "expiresAt" IS NULL;

CREATE INDEX IF NOT EXISTS "UserPromotionSelection_userId_expiresAt_idx"
ON "UserPromotionSelection"("userId", "expiresAt");
