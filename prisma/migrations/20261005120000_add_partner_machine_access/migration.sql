CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'PARTNER', 'ADMIN');

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN "managementAccessActive" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Machine" ADD COLUMN "partnerId" TEXT;
UPDATE "Machine" SET "hardwareId" = LPAD(UPPER(TRIM("hardwareId")), 2, '0')
  WHERE TRIM("hardwareId") ~ '^[0-9A-Fa-f]{1,2}$';
CREATE INDEX "Machine_partnerId_idx" ON "Machine"("partnerId");
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
