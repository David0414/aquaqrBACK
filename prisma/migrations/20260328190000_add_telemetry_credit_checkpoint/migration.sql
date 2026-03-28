-- CreateTable
CREATE TABLE "TelemetryCreditCheckpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "lastPulseCount" INTEGER NOT NULL DEFAULT 0,
    "lastAmountCents" INTEGER NOT NULL DEFAULT 0,
    "lastFrame" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetryCreditCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryCreditCheckpoint_userId_machineId_key" ON "TelemetryCreditCheckpoint"("userId", "machineId");

-- CreateIndex
CREATE INDEX "TelemetryCreditCheckpoint_userId_updatedAt_idx" ON "TelemetryCreditCheckpoint"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "TelemetryCreditCheckpoint" ADD CONSTRAINT "TelemetryCreditCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
