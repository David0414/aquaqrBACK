-- Restore the cashback option requested alongside the deposit bonus.
UPDATE public."AppPromotion"
SET "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'monthly_cashback';
