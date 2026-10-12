-- El catálogo existente conservaba Cashback desactivado.
-- Ejecutar en Supabase SQL Editor para habilitar la segunda opción mensual.
-- No cambia precios, pagos, selecciones guardadas ni otras promociones.
UPDATE public."AppPromotion"
SET "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'monthly_cashback';
