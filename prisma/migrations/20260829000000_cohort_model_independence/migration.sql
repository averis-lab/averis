-- Record what produced each output, and what the cohort behind a result was made of.
--
-- Purely additive, and every column carries a default: existing rows are
-- back-filled with the empty value rather than with a guess. That empty value
-- is load-bearing — the consensus engine reports a cohort whose bindings are
-- unrecorded as `unknown`, and would otherwise have to invent a vendor for
-- every job that ran before this migration.

-- AlterTable
ALTER TABLE "agent_outputs" ADD COLUMN     "modelName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "modelProvider" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "consensus_results" ADD COLUMN     "independence" JSONB NOT NULL DEFAULT '{}';
