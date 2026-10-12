-- Ejecutar DESPUES de ACTUALIZAR_CLIP_PREMIUM.sql en Supabase SQL Editor.
-- Se puede repetir; conserva los pagos anteriores y sus identificadores.
ALTER TABLE public."Recharge"
  ADD COLUMN IF NOT EXISTS "clipFlow" TEXT NOT NULL DEFAULT 'REDIRECTED',
  ADD COLUMN IF NOT EXISTS "clipEnvironment" TEXT,
  ADD COLUMN IF NOT EXISTS "clipChargeStartedAt" TIMESTAMP(3);
ALTER TABLE public."MachinePremiumPayment"
  ADD COLUMN IF NOT EXISTS "clipFlow" TEXT NOT NULL DEFAULT 'REDIRECTED',
  ADD COLUMN IF NOT EXISTS "clipEnvironment" TEXT,
  ADD COLUMN IF NOT EXISTS "clipChargeStartedAt" TIMESTAMP(3);
