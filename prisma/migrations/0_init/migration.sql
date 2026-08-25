-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('CREATED', 'QUEUED', 'ASSIGNED', 'RUNNING', 'SUBMITTED', 'VALIDATING', 'CONSENSUS', 'RESOLVED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'RUNNING', 'SUBMITTED', 'FAILED', 'TIMED_OUT', 'DECLINED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('REPPO_POD', 'REPPO_DATANET', 'ONCHAIN', 'HTTP_API', 'WEB', 'DOCUMENT', 'COMPUTATION', 'PRIOR_INTELLIGENCE');

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('FACT', 'ASSESSMENT', 'PREDICTION', 'RISK', 'RECOMMENDATION');

-- CreateEnum
CREATE TYPE "PredictionOutcome" AS ENUM ('PENDING', 'TRUE', 'FALSE', 'UNRESOLVABLE', 'VOID');

-- CreateEnum
CREATE TYPE "RewardRole" AS ENUM ('AGENT', 'VALIDATOR', 'PROTOCOL', 'TREASURY');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('PENDING', 'APPROVED', 'SETTLED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SIMULATED', 'BROADCAST', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "DataSourceKind" AS ENUM ('REPPO', 'HTTP', 'ONCHAIN', 'UPLOAD', 'CUSTOM');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "handle" TEXT,
    "walletAddress" TEXT,
    "apiKeyHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "strategy" JSONB NOT NULL DEFAULT '{}',
    "budget" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "operatorId" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "modelProvider" TEXT NOT NULL DEFAULT 'mock',
    "modelName" TEXT NOT NULL DEFAULT 'mock-analyst',
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runtimeConfig" JSONB NOT NULL DEFAULT '{}',
    "pricePerJob" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_capabilities" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "skill" TEXT,
    "declared" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "kind" "DataSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datanets" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "curation" JSONB NOT NULL DEFAULT '{}',
    "rubric" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "datanets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_items" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "datanetId" TEXT,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "url" TEXT,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "curation" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB,
    "publishedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT,
    "type" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "target" TEXT,
    "requiredCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredAgents" INTEGER NOT NULL DEFAULT 3,
    "minimumConfidence" DOUBLE PRECISION,
    "budget" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "deadline" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'CREATED',
    "failureReason" TEXT,
    "datanetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "from" "JobStatus",
    "to" "JobStatus" NOT NULL,
    "reason" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_assignments" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "selectionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "selectionDetail" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_outputs" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "recommendation" JSONB,
    "risks" JSONB NOT NULL DEFAULT '[]',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "kind" "ClaimKind" NOT NULL DEFAULT 'ASSESSMENT',
    "statement" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "reliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "dataItemId" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_evidence" (
    "claimId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "stance" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,

    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("claimId","evidenceId")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "evaluatorAgentId" TEXT,
    "evaluatorKind" TEXT NOT NULL DEFAULT 'deterministic',
    "evidenceQuality" DOUBLE PRECISION NOT NULL,
    "internalConsistency" DOUBLE PRECISION NOT NULL,
    "specificity" DOUBLE PRECISION NOT NULL,
    "corroboration" DOUBLE PRECISION NOT NULL,
    "rubricAlignment" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "overall" DOUBLE PRECISION NOT NULL,
    "notes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consensus_results" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "strategyConfig" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "consensusScore" DOUBLE PRECISION NOT NULL,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "recommendation" JSONB,
    "risks" JSONB NOT NULL DEFAULT '[]',
    "disagreements" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consensus_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consensus_contributions" (
    "id" TEXT NOT NULL,
    "consensusId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "agreement" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "consensus_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_scores" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "domain" TEXT,
    "overall" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "calibration" DOUBLE PRECISION NOT NULL,
    "consistency" DOUBLE PRECISION NOT NULL,
    "evidenceQuality" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reputation_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "predictions" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "deadline" TIMESTAMP(3) NOT NULL,
    "outcome" "PredictionOutcome" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_resolutions" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "outcome" "PredictionOutcome" NOT NULL,
    "observedValue" JSONB,
    "resolvedBy" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "brierScore" DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT,
    "role" "RewardRole" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "status" "RewardStatus" NOT NULL DEFAULT 'PENDING',
    "basis" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "rewardId" TEXT,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "intent" JSONB NOT NULL DEFAULT '{}',
    "simulation" JSONB,
    "signature" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_spends" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT,
    "jobId" TEXT,
    "category" TEXT NOT NULL,
    "reserved" DECIMAL(18,6) NOT NULL,
    "actual" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "budget_spends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "users_apiKeyHash_key" ON "users"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "operators_name_key" ON "operators"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE INDEX "agent_capabilities_domain_idx" ON "agent_capabilities"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "agent_capabilities_agentId_domain_skill_key" ON "agent_capabilities"("agentId", "domain", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_name_key" ON "data_sources"("name");

-- CreateIndex
CREATE INDEX "datanets_syncedAt_idx" ON "datanets"("syncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "datanets_dataSourceId_externalId_key" ON "datanets"("dataSourceId", "externalId");

-- CreateIndex
CREATE INDEX "data_items_datanetId_idx" ON "data_items"("datanetId");

-- CreateIndex
CREATE UNIQUE INDEX "data_items_dataSourceId_externalId_key" ON "data_items"("dataSourceId", "externalId");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "jobs_type_idx" ON "jobs"("type");

-- CreateIndex
CREATE INDEX "job_events_jobId_createdAt_idx" ON "job_events"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "job_assignments_status_idx" ON "job_assignments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "job_assignments_jobId_agentId_key" ON "job_assignments"("jobId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_outputs_assignmentId_key" ON "agent_outputs"("assignmentId");

-- CreateIndex
CREATE INDEX "agent_outputs_jobId_idx" ON "agent_outputs"("jobId");

-- CreateIndex
CREATE INDEX "claims_outputId_idx" ON "claims"("outputId");

-- CreateIndex
CREATE INDEX "claims_fingerprint_idx" ON "claims"("fingerprint");

-- CreateIndex
CREATE INDEX "evidence_jobId_idx" ON "evidence"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_jobId_contentHash_key" ON "evidence"("jobId", "contentHash");

-- CreateIndex
CREATE INDEX "evaluations_jobId_idx" ON "evaluations"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_outputId_evaluatorAgentId_evaluatorKind_key" ON "evaluations"("outputId", "evaluatorAgentId", "evaluatorKind");

-- CreateIndex
CREATE UNIQUE INDEX "consensus_results_jobId_key" ON "consensus_results"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "consensus_contributions_consensusId_outputId_key" ON "consensus_contributions"("consensusId", "outputId");

-- CreateIndex
CREATE INDEX "reputation_scores_agentId_domain_createdAt_idx" ON "reputation_scores"("agentId", "domain", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "predictions_claimId_key" ON "predictions"("claimId");

-- CreateIndex
CREATE INDEX "predictions_outcome_deadline_idx" ON "predictions"("outcome", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "prediction_resolutions_predictionId_key" ON "prediction_resolutions"("predictionId");

-- CreateIndex
CREATE INDEX "rewards_jobId_idx" ON "rewards"("jobId");

-- CreateIndex
CREATE INDEX "rewards_status_idx" ON "rewards"("status");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_rewardId_key" ON "transactions"("rewardId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_signature_key" ON "transactions"("signature");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "budget_spends_operatorId_createdAt_idx" ON "budget_spends"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "budget_spends_jobId_idx" ON "budget_spends"("jobId");

-- AddForeignKey
ALTER TABLE "operators" ADD CONSTRAINT "operators_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datanets" ADD CONSTRAINT "datanets_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_items" ADD CONSTRAINT "data_items_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_items" ADD CONSTRAINT "data_items_datanetId_fkey" FOREIGN KEY ("datanetId") REFERENCES "datanets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_outputs" ADD CONSTRAINT "agent_outputs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_outputs" ADD CONSTRAINT "agent_outputs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_outputs" ADD CONSTRAINT "agent_outputs_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "job_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "agent_outputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_dataItemId_fkey" FOREIGN KEY ("dataItemId") REFERENCES "data_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "agent_outputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_evaluatorAgentId_fkey" FOREIGN KEY ("evaluatorAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consensus_results" ADD CONSTRAINT "consensus_results_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consensus_contributions" ADD CONSTRAINT "consensus_contributions_consensusId_fkey" FOREIGN KEY ("consensusId") REFERENCES "consensus_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consensus_contributions" ADD CONSTRAINT "consensus_contributions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consensus_contributions" ADD CONSTRAINT "consensus_contributions_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "agent_outputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_scores" ADD CONSTRAINT "reputation_scores_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_resolutions" ADD CONSTRAINT "prediction_resolutions_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_spends" ADD CONSTRAINT "budget_spends_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_spends" ADD CONSTRAINT "budget_spends_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

