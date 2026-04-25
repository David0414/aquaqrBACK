CREATE TABLE "MachineLock" (
    "machineId" TEXT NOT NULL,
    "hardwareId" TEXT,
    "userId" TEXT NOT NULL,
    "txId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineLock_pkey" PRIMARY KEY ("machineId")
);

CREATE INDEX "MachineLock_userId_idx" ON "MachineLock"("userId");
CREATE INDEX "MachineLock_hardwareId_idx" ON "MachineLock"("hardwareId");
CREATE INDEX "MachineLock_expiresAt_idx" ON "MachineLock"("expiresAt");

ALTER TABLE "MachineLock" ADD CONSTRAINT "MachineLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
