-- Also suitable for pasting into the Supabase SQL Editor.
BEGIN;
ALTER TABLE public."Machine" ADD COLUMN IF NOT EXISTS "coinsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public."UserMembership" ADD COLUMN IF NOT EXISTS "machineId" TEXT;
ALTER TABLE public."UserMembership" ADD COLUMN IF NOT EXISTS "purchaseKey" TEXT;
ALTER TABLE public."UserMembership" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE public."Dispense" ADD COLUMN IF NOT EXISTS "membershipCoveredLiters" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE public."Dispense" ADD COLUMN IF NOT EXISTS "membershipCoveredCents" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "UserMembership_purchaseKey_key" ON public."UserMembership"("purchaseKey");
CREATE INDEX IF NOT EXISTS "UserMembership_userId_machineId_status_idx" ON public."UserMembership"("userId", "machineId", "status");
-- Preserve purchased water. Memberships end when their included liters are used.
UPDATE public."UserMembership" SET "expiresAt" = NULL WHERE "status" = 'ACTIVE';
UPDATE public."UserMembership" AS membership SET "machineId" = machine."id"
FROM public."Machine" AS machine
WHERE membership."machineId" IS NULL AND membership."metadata"->>'machineId' = machine."id";
UPDATE public."UserMembership" SET "status" = 'USED'
WHERE "status" = 'ACTIVE' AND "litersRemaining" <= 0;
UPDATE public."UserPromotionSelection" SET "expiresAt" = NULL
WHERE "promotionKey" IN ('premium_membership_1', 'premium_membership_2', 'premium_membership_3');
COMMIT;
