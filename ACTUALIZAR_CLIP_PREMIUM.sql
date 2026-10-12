-- Ejecutar completo en Supabase SQL Editor, antes de publicar el backend.
ALTER TYPE public."Provider" ADD VALUE IF NOT EXISTS 'CLIP';
ALTER TABLE public."Recharge" ADD COLUMN IF NOT EXISTS "checkoutUrl" TEXT;
ALTER TABLE public."Recharge" ADD COLUMN IF NOT EXISTS "checkoutRequestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Recharge_checkoutRequestId_key" ON public."Recharge"("checkoutRequestId");

CREATE TABLE IF NOT EXISTS public."MachinePremiumPlan" (
  "key" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "maxGarrafones" INTEGER,
  "monthlyPriceCents" INTEGER NOT NULL, "sortOrder" INTEGER NOT NULL
);
INSERT INTO public."MachinePremiumPlan" ("key", "label", "maxGarrafones", "monthlyPriceCents", "sortOrder") VALUES
  ('basic', 'Básico', 100, 27100, 1), ('basic_plus', 'Básico+', 150, 33000, 2),
  ('intermediate', 'Intermedio', 250, 44900, 3), ('intermediate_plus', 'Intermedio+', 350, 56900, 4),
  ('advanced', 'Avanzado', 500, 74800, 5), ('advanced_plus', 'Avanzado+', 600, 86700, 6),
  ('premium', 'Premium', NULL, 98600, 7)
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE IF NOT EXISTS public."MachinePremiumPayment" (
  "id" TEXT PRIMARY KEY, "machineId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL, "amountCents" INTEGER NOT NULL, "segment" TEXT NOT NULL,
  "volumeGarrafones" DOUBLE PRECISION NOT NULL, "volumeFrom" TIMESTAMP(3) NOT NULL, "volumeTo" TIMESTAMP(3) NOT NULL,
  "providerPaymentId" TEXT, "checkoutUrl" TEXT, "status" public."RechargeStatus" NOT NULL DEFAULT 'PENDING',
  "startsAt" TIMESTAMP(3), "endsAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MachinePremiumPayment_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES public."Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MachinePremiumPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "MachinePremiumPayment_requestId_key" ON public."MachinePremiumPayment"("requestId");
CREATE UNIQUE INDEX IF NOT EXISTS "MachinePremiumPayment_providerPaymentId_key" ON public."MachinePremiumPayment"("providerPaymentId");
CREATE INDEX IF NOT EXISTS "MachinePremiumPayment_machineId_status_endsAt_idx" ON public."MachinePremiumPayment"("machineId", "status", "endsAt");
CREATE INDEX IF NOT EXISTS "MachinePremiumPayment_userId_createdAt_idx" ON public."MachinePremiumPayment"("userId", "createdAt");
ALTER TABLE public."MachinePremiumPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MachinePremiumPayment" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public."MachinePremiumPlan", public."MachinePremiumPayment" FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public."MachinePremiumPlan", public."MachinePremiumPayment" FROM authenticated;
  END IF;
END $$;

-- Beneficios de clientes según la tabla suministrada. Conserva activación y pagos anteriores.
UPDATE public."AppPromotion" SET "description" = 'Desde $100: 2.5%; desde $200: 3.5%; $500: 4.5%. La membresía de agua reemplaza el bono por depósito.',
 "config" = COALESCE("config", '{}'::jsonb) || '{"tiers":[{"amountCents":10000,"bonusCents":250,"bonusPercent":2.5,"label":"Desde $100: 2.5%"},{"amountCents":20000,"bonusCents":700,"bonusPercent":3.5,"label":"Desde $200: 3.5%"},{"amountCents":50000,"bonusCents":2250,"bonusPercent":4.5,"label":"$500: 4.5%"}]}'::jsonb
WHERE "key" = 'topup_bonus';
UPDATE public."AppPromotion" SET "config" = COALESCE("config", '{}'::jsonb) || '{"tiers":[{"maxGarrafones":null,"cashbackPerGarrafonCents":50,"label":"$0.50 por garrafón"}]}'::jsonb WHERE "key" = 'monthly_cashback';
UPDATE public."AppPromotion" SET "title" = 'EVA Coins por consumo mensual', "description" = 'EVA Coins siempre se acumula. Al cierre del mes: desde 200 puntos recibes $10, desde 500 recibes $20 y desde 1,000 recibes $30.', "config" = COALESCE("config", '{}'::jsonb) || '{"pointsPerLiter":0.5,"resetAtPoints":0,"tiers":[{"minPoints":0,"bonusCents":0,"label":"0–199: sin bono"},{"minPoints":200,"bonusCents":1000,"label":"200 puntos: $10"},{"minPoints":500,"bonusCents":2000,"label":"500 puntos: $20"},{"minPoints":1000,"bonusCents":3000,"label":"1,000 puntos: $30"}]}'::jsonb WHERE "key" = 'monthly_consumption_points';
UPDATE public."AppPromotion" SET "title" = 'Paquete de 5 garrafones', "config" = COALESCE("config", '{}'::jsonb) || '{"discountPerGarrafonCents":20}'::jsonb WHERE "key" = 'premium_membership_1';
UPDATE public."AppPromotion" SET "title" = 'Paquete de 8 garrafones', "config" = COALESCE("config", '{}'::jsonb) || '{"discountPerGarrafonCents":30}'::jsonb WHERE "key" = 'premium_membership_2';
UPDATE public."AppPromotion" SET "title" = 'Paquete de 11 garrafones', "config" = COALESCE("config", '{}'::jsonb) || '{"discountPerGarrafonCents":40}'::jsonb WHERE "key" = 'premium_membership_3';
