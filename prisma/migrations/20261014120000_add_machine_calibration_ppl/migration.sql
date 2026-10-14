ALTER TABLE public."Machine"
ADD COLUMN IF NOT EXISTS "calibrationPulsesPerLiter" INTEGER;
