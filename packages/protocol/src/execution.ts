import { Prisma, prisma, toDecimalInput, toNumber } from "@averis/db";
import { BudgetExceededError } from "@averis/budget";
import {
  createLLMProvider,
  providerIsConfigured,
  runAgent,
  type AgentRunResult,
  type DatanetRubric,
} from "@averis/agent-runtime";
import { QUEUES } from "@averis/queue";
import { claimFingerprint, type CreateJob, type Datanet } from "@averis/types";
import type { ProtocolContext } from "./context";
import { JobEngine, JobEngineError } from "./job-engine";

/**
 * Rough upper bound on what one agent run costs, used by the budget guard
 * before any tokens are spent. Intentionally an over-estimate: reserving too
 * much only delays work, whereas reserving too little defeats the guard.
 */
const ESTIMATED_AGENT_COST_USD = 0.35;

/**
 * Cached-item writes allowed in flight at once, per agent run. Deliberately
 * well under `DATABASE_POOL_MAX`: these run alongside the interactive
 * transactions of every other agent in the cohort.
 */
const DATA_ITEM_WRITE_CONCURRENCY = 8;

export interface RunJobResult {
  jobId: string;
  assignments: number;
  succeeded: number;
  failed: number;
}

/**
 * Selects a cohort, runs it, and records the results.
 *
 * The three phases — select, execute, submit — are separate transitions with
 * their own audit events, so a job that dies partway is diagnosable from the
 * event log alone.
 */
export class ExecutionPipeline {
  private readonly engine: JobEngine;
  /** Resolved once: a data source's name → id mapping never changes. */
  private sourceId: string | null = null;

  constructor(private readonly ctx: ProtocolContext) {
    this.engine = new JobEngine(ctx);
  }

  async runJob(jobId: string): Promise<RunJobResult> {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new JobEngineError(`Job ${jobId} not found`);

    if (job.deadline && job.deadline.getTime() < Date.now()) {
      await this.engine.fail(jobId, "deadline passed before execution started");
      return { jobId, assignments: 0, succeeded: 0, failed: 0 };
    }

    // ─── Data discovery ─────────────────────────────────────────────────────
    // Scope the job to relevant datanets before any agent runs, so every agent
    // in the cohort works from the same evidence pool. Letting each agent
    // discover independently would confound "agents disagreed" with "agents
    // read different data", and the consensus signal would be meaningless.
    const datanets = await this.discoverDatanets(
      job.datanetIds,
      job.requiredCapabilities,
      job.query,
    );
    const datanetIds = datanets.map((d) => d.id);

    if (datanetIds.length > 0 && datanetIds.join() !== job.datanetIds.join()) {
      await prisma.job.update({ where: { id: jobId }, data: { datanetIds } });
    }

    // Snapshot the datanets, rubric included. A datanet can rewrite its
    // standard at any time; without a snapshot an old job's evaluation could
    // not be reproduced or defended later.
    await this.snapshotDatanets(datanets);

    // ─── Agent selection ────────────────────────────────────────────────────
    //
    // Agents whose provider has no credentials are dropped *before* selection.
    // Creating the provider is the first thing the run does, and by then the
    // budget is already reserved — and a reservation is deliberately kept on
    // failure, so a missing key would burn a job's allowance without a single
    // model call ever being made. Failing here costs nothing and says why.
    const allCandidates = await this.engine.candidates();
    const candidates = allCandidates.filter((agent) =>
      providerIsConfigured(agent.modelProvider, this.ctx.env),
    );
    const unconfigured = allCandidates.length - candidates.length;

    if (unconfigured > 0) {
      this.ctx.logger.warn("agents skipped: provider not configured", {
        jobId,
        skipped: unconfigured,
        providers: [
          ...new Set(
            allCandidates
              .filter((agent) => !providerIsConfigured(agent.modelProvider, this.ctx.env))
              .map((agent) => agent.modelProvider),
          ),
        ],
      });
    }

    const budgetPerAgent =
      job.requiredAgents > 0 ? toNumber(job.budget) / job.requiredAgents : toNumber(job.budget);

    const selected = this.ctx.selector.select(candidates, {
      requiredCapabilities: job.requiredCapabilities,
      requiredAgents: job.requiredAgents,
      ...(toNumber(job.budget) > 0 ? { maxPricePerAgent: budgetPerAgent } : {}),
    });

    if (selected.length === 0) {
      // Two different problems with two different fixes. Reporting the second
      // as the first sends an operator to check capability tags when what is
      // actually missing is an API key.
      const reason =
        candidates.length === 0 && unconfigured > 0
          ? "no agent has usable model credentials"
          : "no agent matched the required capabilities";

      await this.engine.fail(jobId, reason, {
        requiredCapabilities: job.requiredCapabilities,
        candidates: candidates.length,
        skippedForCredentials: unconfigured,
      });
      return { jobId, assignments: 0, succeeded: 0, failed: 0 };
    }

    await prisma.jobAssignment.createMany({
      data: selected.map((s) => ({
        jobId,
        agentId: s.agentId,
        status: "PENDING" as const,
        selectionScore: s.score,
        selectionDetail: s.detail as object,
      })),
      skipDuplicates: true,
    });

    await this.engine.transition(jobId, "ASSIGNED", `selected ${selected.length} agent(s)`, {
      agents: selected.map((s) => s.agentId),
      datanetIds,
    });
    await this.engine.transition(jobId, "RUNNING", "agents executing");

    // ─── Parallel execution ─────────────────────────────────────────────────
    const assignments = await prisma.jobAssignment.findMany({
      where: { jobId },
      include: { agent: { include: { capabilities: true } } },
    });

    const deadline = job.deadline ?? new Date(Date.now() + 5 * 60 * 1000);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1_000, deadline.getTime() - Date.now()),
    );

    // Each agent is shown what the datanets in scope say good work looks like.
    const rubrics = datanets
      .filter((d) => d.rubric.publisherSpec || d.rubric.voterRubric)
      .map((d) => ({
        id: d.id,
        name: d.name,
        publisherSpec: d.rubric.publisherSpec,
        voterRubric: d.rubric.voterRubric,
      }));

    let succeeded = 0;
    let failed = 0;

    try {
      const outcomes = await Promise.allSettled(
        assignments.map((assignment) =>
          this.runAssignment(
            {
              id: assignment.id,
              agentId: assignment.agentId,
              agentName: assignment.agent.name,
              agentDescription: assignment.agent.description ?? "",
              capabilities: assignment.agent.capabilities.map((c) => ({
                domain: c.domain,
                skill: c.skill,
                declared: c.declared,
              })),
              modelProvider: assignment.agent.modelProvider,
              modelName: assignment.agent.modelName,
              tools: assignment.agent.tools,
            },
            {
              jobId,
              type: job.type,
              query: job.query,
              target: job.target,
              minimumConfidence: job.minimumConfidence,
              datanetIds,
              rubrics,
            },
            controller.signal,
          ),
        ),
      );

      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") succeeded++;
        else {
          failed++;
          this.ctx.logger.warn("agent run failed", {
            jobId,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (succeeded === 0) {
      await this.engine.fail(jobId, "every agent in the cohort failed to produce output", {
        attempted: assignments.length,
      });
      return { jobId, assignments: assignments.length, succeeded, failed };
    }

    await this.engine.transition(jobId, "SUBMITTED", `${succeeded} of ${assignments.length} agents submitted`);
    await this.ctx.queue.enqueue(
      QUEUES.evaluation,
      "evaluate",
      { jobId },
      { jobId: `eval:${jobId}` },
    );

    return { jobId, assignments: assignments.length, succeeded, failed };
  }

  /**
   * Runs one agent under a budget reservation.
   *
   * The reservation is taken *before* the agent starts, so a job cannot exceed
   * its budget by discovering the cost afterwards.
   */
  private async runAssignment(
    agent: {
      id: string;
      agentId: string;
      agentName: string;
      agentDescription: string;
      capabilities: Array<{ domain: string; skill: string | null; declared: number }>;
      modelProvider: string;
      modelName: string;
      tools: string[];
    },
    job: {
      jobId: string;
      type: string;
      query: string;
      target: string | null;
      minimumConfidence: number | null;
      datanetIds: string[];
      rubrics: DatanetRubric[];
    },
    signal: AbortSignal,
  ): Promise<void> {
    await prisma.jobAssignment.update({
      where: { id: agent.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    try {
      // Built before the reservation, for two reasons. A provider that cannot
      // be constructed spends nothing, so failing here rather than inside the
      // budget closure no longer burns a reservation on a misconfiguration.
      // And the binding it resolves — after the registry's blanks are filled
      // in from the environment — is what actually answers, which is the thing
      // worth recording against the output.
      const provider = createLLMProvider(
        { provider: agent.modelProvider, model: agent.modelName },
        this.ctx.env,
      );

      const result = await this.ctx.budget.withBudget(
        {
          operatorId: null,
          jobId: job.jobId,
          agentId: agent.agentId,
          category: "llm",
          estimatedUsd: ESTIMATED_AGENT_COST_USD,
          detail: { agentName: agent.agentName },
        },
        async () => {
          const run = await runAgent({
            jobId: job.jobId,
            agentId: agent.agentId,
            agentName: agent.agentName,
            agentDescription: agent.agentDescription,
            capabilities: agent.capabilities,
            jobType: job.type,
            query: job.query,
            target: job.target,
            minimumConfidence: job.minimumConfidence,
            datanetIds: job.datanetIds,
            rubrics: job.rubrics,
            provider,
            registry: this.ctx.tools,
            allowedTools: agent.tools.length > 0 ? agent.tools : this.ctx.tools.names(),
            data: this.ctx.data,
            signal,
            logger: (message, detail) => this.ctx.logger.info(message, { agent: agent.agentName, ...detail }),
          });

          return { result: run, actualUsd: run.usage.costUsd };
        },
      );

      await this.persist(job.jobId, agent.agentId, agent.id, result, {
        provider: provider.name,
        model: provider.model,
      });

      await prisma.jobAssignment.update({
        where: { id: agent.id },
        data: { status: "SUBMITTED", endedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.jobAssignment.update({
        where: { id: agent.id },
        data: {
          status: error instanceof BudgetExceededError ? "DECLINED" : "FAILED",
          endedAt: new Date(),
          error: message.slice(0, 500),
        },
      });
      throw error;
    }
  }

  /** Writes the agent's output, its evidence, and the claim→evidence links. */
  private async persist(
    jobId: string,
    agentId: string,
    assignmentId: string,
    run: AgentRunResult,
    /**
     * What actually answered, recorded against the output rather than left to
     * a join on the agent registry. The registry is editable, and a cohort's
     * model mix is part of what a finished result means: re-deriving it later
     * would let a routine registry edit rewrite the provenance of a claim
     * somebody already acted on.
     */
    binding: { provider: string; model: string },
  ): Promise<void> {
    // Cache the upstream items this run cited *before* opening the
    // transaction. They belong to the data-source cache rather than to the
    // job, they are idempotent, and a dozen extra round trips held inside an
    // interactive transaction is exactly how this codebase has produced
    // "Transaction already closed" under load before.
    const dataItemIds = await this.cacheDataItems(run.evidence);

    await prisma.$transaction(async (tx) => {
      // Evidence is deduplicated per job by content hash, so two agents
      // citing the same upstream item share one provenance row.
      //
      // This must be an atomic insert-or-ignore, not an upsert. Agents in a
      // cohort run in parallel and routinely retrieve the same pods; two
      // concurrent transactions each check "does it exist", both see no, and
      // both insert — and one loses its entire output to a unique-constraint
      // violation. `createMany({ skipDuplicates })` compiles to
      // ON CONFLICT DO NOTHING, which the database resolves atomically.
      if (run.evidence.length > 0) {
        await tx.evidence.createMany({
          data: run.evidence.map((item) => ({
            jobId,
            type: item.type,
            source: item.source,
            title: item.title,
            content: item.content?.slice(0, 20_000) ?? null,
            contentHash: String(item.metadata["contentHash"] ?? item.id),
            metadata: item.metadata as object,
            reliability: item.reliability,
            retrievedAt: item.timestamp,
            dataItemId: dataItemIds.get(item.source) ?? null,
          })),
          skipDuplicates: true,
        });
      }

      // Read back the ids, which now cover both rows this agent inserted and
      // rows a concurrent agent inserted first.
      const evidenceRows = await tx.evidence.findMany({
        where: {
          jobId,
          contentHash: {
            in: run.evidence.map((item) => String(item.metadata["contentHash"] ?? item.id)),
          },
        },
        select: { id: true, source: true },
      });
      const evidenceIdByKey = new Map(evidenceRows.map((row) => [row.source, row.id]));

      const output = await tx.agentOutput.create({
        data: {
          jobId,
          agentId,
          assignmentId,
          summary: run.summary,
          confidence: run.confidence,
          modelProvider: binding.provider,
          modelName: binding.model,
          metrics: run.metrics as object,
          recommendation: run.recommendation === null ? Prisma.JsonNull : (run.recommendation as object),
          risks: run.risks as object,
          tokensIn: run.usage.inputTokens,
          tokensOut: run.usage.outputTokens,
          costUsd: toDecimalInput(run.usage.costUsd),
          durationMs: run.durationMs,
          toolCalls: run.toolCalls as object,
        },
        select: { id: true },
      });

      for (const [position, claim] of run.claims.entries()) {
        const claimRow = await tx.claim.create({
          data: {
            outputId: output.id,
            kind: claim.kind,
            statement: claim.statement,
            confidence: claim.confidence,
            fingerprint: claim.fingerprint || claimFingerprint(claim.statement),
            position,
            ...(claim.resolution
              ? {
                  prediction: {
                    create: {
                      statement: claim.statement,
                      confidence: claim.confidence,
                      criteria: claim.resolution as object,
                      deadline: new Date(claim.resolution.deadline),
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        });

        const links = claim.evidence
          .map((item) => evidenceIdByKey.get(item.source))
          .filter((id): id is string => id !== undefined)
          .map((evidenceId) => ({ claimId: claimRow.id, evidenceId, stance: 1 }));

        if (links.length > 0) {
          await tx.claimEvidence.createMany({ data: links, skipDuplicates: true });
        }
      }
    });
  }

  /**
   * Finds datanets relevant to the job.
   *
   * Explicit scoping on the job always wins. Otherwise the job's required
   * capabilities are matched against datanet domains, falling back to a
   * text search when no domain matches — an empty evidence pool is the worst
   * outcome, so discovery degrades rather than returning nothing.
   */
  private async discoverDatanets(
    explicit: string[],
    capabilities: string[],
    query: string,
  ): Promise<Datanet[]> {
    const datanets = await this.ctx.data.listDatanets({ limit: 50 });
    if (datanets.length === 0) return [];

    if (explicit.length > 0) {
      const wanted = new Set(explicit);
      return datanets.filter((d) => wanted.has(d.id));
    }

    const wanted = new Set(capabilities.map((c) => c.toLowerCase()));
    const byDomain =
      wanted.size > 0
        ? datanets.filter((d) => d.domains.some((domain) => wanted.has(domain)))
        : [];

    const pool = byDomain.length > 0 ? byDomain : this.textMatch(datanets, query);

    return pool
      // Prefer datanets whose curators actually corroborate their content.
      .sort((a, b) => b.curation.approvalRate - a.curation.approvalRate)
      .slice(0, 5);
  }

  /** Caches the datanets a job used, so its evidence keeps its provenance. */
  private async snapshotDatanets(datanets: Datanet[]): Promise<void> {
    if (datanets.length === 0) return;

    const sourceId = await this.dataSourceId();
    if (!sourceId) return;

    for (const datanet of datanets) {
      await prisma.datanet.upsert({
        where: { dataSourceId_externalId: { dataSourceId: sourceId, externalId: datanet.id } },
        create: {
          dataSourceId: sourceId,
          externalId: datanet.id,
          name: datanet.name,
          description: datanet.description,
          domains: datanet.domains,
          curation: datanet.curation as object,
          rubric: datanet.rubric as object,
          raw: datanet.raw as object,
        },
        update: {
          name: datanet.name,
          description: datanet.description,
          domains: datanet.domains,
          curation: datanet.curation as object,
          rubric: datanet.rubric as object,
          syncedAt: new Date(),
        },
      });
    }
  }

  /** The configured data source's local id, or null if it was never seeded. */
  private async dataSourceId(): Promise<string | null> {
    if (this.sourceId) return this.sourceId;

    const source = await prisma.dataSource.findUnique({
      where: { name: this.ctx.data.name },
      select: { id: true },
    });
    // Only a hit is memoised: a source seeded after the first miss must still
    // be found, rather than this pipeline caching "absent" for its lifetime.
    if (source) this.sourceId = source.id;
    return source?.id ?? null;
  }

  /**
   * Caches the upstream items this run cited and returns their local ids,
   * keyed by evidence locator.
   *
   * Evidence keeps an immutable snapshot of what a pod looked like when it was
   * read — that is what an old job's score has to be defensible against. The
   * `DataItem` row is the *identity* behind that snapshot, so two jobs citing
   * the same pod point at one row and "what else drew on this pod", or "how
   * has its curation moved since we used it", become answerable. Without the
   * link, provenance is a string with nothing to join it to.
   *
   * Only pods are cached. A datanet listing is not an item, and evidence from
   * any other tool has no upstream row to point at; both keep a null link
   * rather than getting a synthetic one.
   */
  private async cacheDataItems(evidence: AgentRunResult["evidence"]): Promise<Map<string, string>> {
    const byLocator = new Map<string, string>();

    const pods = evidence.filter(
      (item) => item.type === "REPPO_POD" && typeof item.metadata["externalId"] === "string",
    );
    if (pods.length === 0) return byLocator;

    const sourceId = await this.dataSourceId();
    if (!sourceId) return byLocator;

    // Evidence carries the *upstream* datanet id; the foreign key wants the
    // local snapshot row that `snapshotDatanets` wrote when the job started.
    // A pod whose datanet is somehow not in scope keeps a null link — the item
    // is still real provenance, it just has no local parent to hang from.
    const externalDatanetIds = [
      ...new Set(pods.map((item) => asString(item.metadata["datanetId"])).filter(isPresent)),
    ];
    const datanetRows =
      externalDatanetIds.length > 0
        ? await prisma.datanet.findMany({
            where: { dataSourceId: sourceId, externalId: { in: externalDatanetIds } },
            select: { id: true, externalId: true },
          })
        : [];
    const localDatanetId = new Map(datanetRows.map((row) => [row.externalId, row.id]));

    // Bounded rather than one flat `Promise.all`: an agent can cite dozens of
    // pods and a cohort runs three of these at once, which is enough open
    // requests to starve the connection pool — and what starves there is the
    // *interactive transaction* another agent is holding open in `persist`,
    // which dies as "Transaction already closed" nowhere near this code.
    for (const batch of chunk(pods, DATA_ITEM_WRITE_CONCURRENCY)) {
      await Promise.all(
        batch.map(async (item) => {
          const externalId = asString(item.metadata["externalId"]);
          if (!externalId) return;

          const externalDatanetId = asString(item.metadata["datanetId"]);
          const values = {
            datanetId: externalDatanetId ? (localDatanetId.get(externalDatanetId) ?? null) : null,
            title: item.title ?? externalId,
            content: item.content?.slice(0, 20_000) ?? null,
            url: asString(item.metadata["url"]),
            // The upstream curation score, the same number the evidence row
            // carries as its reliability. Never the agent's opinion of the item.
            qualityScore: item.reliability,
            curation: {
              upVotes: asNumber(item.metadata["upVotes"], 0),
              downVotes: asNumber(item.metadata["downVotes"], 0),
              approvalRate: asNumber(item.metadata["approvalRate"], 0.5),
              epoch: asNumber(item.metadata["epoch"], null),
            },
            publishedAt: asDate(item.metadata["publishedAt"]),
          };

          // Unlike evidence, this is an upsert rather than an insert-or-ignore:
          // agents in a cohort routinely retrieve the same pod, and the second
          // one to arrive should refresh the cached curation instead of being
          // dropped. It is safe under that parallelism because the compound
          // unique is the arbiter — one statement, not a check followed by a
          // write — and both writers are copying the same upstream row anyway.
          const row = await prisma.dataItem.upsert({
            where: { dataSourceId_externalId: { dataSourceId: sourceId, externalId } },
            create: { dataSourceId: sourceId, externalId, ...values },
            update: { ...values, syncedAt: new Date() },
            select: { id: true },
          });
          byLocator.set(item.source, row.id);
        }),
      );
    }

    return byLocator;
  }

  private textMatch<T extends { name: string; description: string }>(
    datanets: T[],
    query: string,
  ): T[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3);
    if (terms.length === 0) return datanets.slice(0, 5);

    const scored = datanets
      .map((d) => {
        const haystack = `${d.name} ${d.description}`.toLowerCase();
        return { d, hits: terms.filter((t) => haystack.includes(t)).length };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    return scored.length > 0 ? scored.map((s) => s.d) : datanets.slice(0, 5);
  }
}

/**
 * Evidence metadata is an open `Record<string, unknown>` by design — a tool can
 * attach whatever it retrieved. Reading it back into typed columns therefore
 * coerces rather than casts: a malformed value falls back instead of throwing
 * mid-persist and costing the agent its entire output.
 */
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function asNumber(value: unknown, fallback: number): number;
function asNumber(value: unknown, fallback: null): number | null;
function asNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asDate(value: unknown): Date | null {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export type { CreateJob };
