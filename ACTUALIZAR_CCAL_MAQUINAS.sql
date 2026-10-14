-- Ejecuta este archivo en Supabase SQL Editor antes de desplegar el backend.
-- Conserva una calibración Ccal (pulsos por litro) independiente para cada máquina.
ALTER TABLE public."Machine"
ADD COLUMN IF NOT EXISTS "calibrationPulsesPerLiter" INTEGER;
