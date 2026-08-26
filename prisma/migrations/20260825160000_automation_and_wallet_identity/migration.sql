-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ExitReason" AS ENUM ('TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'MAX_HOLD', 'MANUAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "privyId" TEXT;

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "breakerResetAt" TIMESTAMP(3),
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "sizeUsd" DECIMAL(18,6) NOT NULL,
    "entryPrice" DECIMAL(24,12) NOT NULL,
    "peakPrice" DECIMAL(24,12) NOT NULL,
    "exitPrice" DECIMAL(24,12),
    "pnlUsd" DECIMAL(18,6),
    "exitReason" "ExitReason",
    "confidence" DOUBLE PRECISION NOT NULL,
    "consensus" DOUBLE PRECISION NOT NULL,
    "agentsReporting" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "message" TEXT NOT NULL,
    "jobId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_active_mode_idx" ON "automations"("active", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "automations_ownerId_name_key" ON "automations"("ownerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "positions_jobId_key" ON "positions"("jobId");

-- CreateIndex
CREATE INDEX "positions_automationId_status_idx" ON "positions"("automationId", "status");

-- CreateIndex
CREATE INDEX "positions_automationId_closedAt_idx" ON "positions"("automationId", "closedAt");

-- CreateIndex
CREATE INDEX "automation_events_automationId_createdAt_idx" ON "automation_events"("automationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_privyId_key" ON "users"("privyId");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

