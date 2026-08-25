import type { CreateJobInput, JobStatus, RegisterAgentInput } from "@averis/types";

export interface AverisConfig {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AverisError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AverisError";
  }
}

/** One way a gateway will accept payment for a request. */
export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Raised when the gateway wants payment for a request (HTTP 402).
 *
 * The client does not pay by itself: paying needs a wallet, and a wallet is not
 * something an API client should quietly acquire. What it does instead is
 * decode what was asked for, so the caller can decide — and say plainly how to
 * make the next attempt succeed. Pass a payment-capable `fetchImpl` and the
 * round trip happens inside `fetch`, invisible to every method here.
 */
export class PaymentRequiredError extends AverisError {
  constructor(
    readonly accepts: PaymentOption[],
    detail?: unknown,
  ) {
    const first = accepts[0];
    super(
      402,
      first
        ? `Payment required: ${first.amount} of ${first.asset} on ${first.network} to ${first.payTo}. ` +
            "Pass a payment-capable fetch, e.g. createClient({ fetchImpl: wrapFetchWithPayment(fetch, x402Client) })."
        : "Payment required, but the response carried no payment options.",
      detail,
    );
    this.name = "PaymentRequiredError";
  }
}

/** Decodes the base64 JSON an x402 gateway puts in its 402 response. */
function decodePaymentRequired(header: string | null): PaymentOption[] {
  if (!header) return [];
  try {
    const json =
      typeof atob === "function"
        ? atob(header)
        : Buffer.from(header, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    const accepts = (parsed as { accepts?: unknown }).accepts;
    return Array.isArray(accepts) ? (accepts as PaymentOption[]) : [];
  } catch {
    // A malformed challenge is still a 402; it just cannot say what it wants.
    return [];
  }
}

export interface JobSummary {
  id: string;
  type: string;
  query: string;
  target: string | null;
  status: JobStatus;
  budget: number;
  requiredAgents: number;
  requiredCapabilities: string[];
  minimumConfidence: number | null;
  datanetIds: string[];
  failureReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  confidence?: number | null;
  consensusScore?: number | null;
  agentCount?: number;
  evidenceCount?: number;
}

export interface EvidenceRef {
  source: string;
  title: string | null;
  reliability: number;
  stance: number;
}

export interface IntelligenceClaim {
  statement: string;
  kind: string;
  confidence: number;
  support: number;
  supportedBy: string[];
  contradictedBy: string[];
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
}

export interface IntelligenceReport {
  job: JobSummary;
  intelligence: {
    summary: string;
    confidence: number;
    consensusScore: number;
    /** How much independent corroboration stood behind the result. */
    corroboration: {
      cohortSize: number;
      expected: number;
      factor: number;
      short: boolean;
    } | null;
    strategy: string;
    claims: IntelligenceClaim[];
    metrics: Record<string, number | string>;
    recommendation: { action: string; rationale: string; confidence: number } | null;
    risks: Array<{ description: string; severity: string; likelihood: number }>;
    disagreements: Array<{
      statement: string;
      supportWeight: number;
      opposeWeight: number;
      positions: Array<{ agentId: string; statement: string; confidence: number }>;
    }>;
  };
  contributions: Array<{
    agentId: string;
    agentName: string;
    weight: number;
    agreement: number;
    breakdown: Record<string, number>;
  }>;
  agentOutputs: Array<{
    agentId: string;
    agentName: string;
    summary: string;
    confidence: number;
    claims: Array<{
      statement: string;
      kind: string;
      confidence: number;
      evidence: EvidenceRef[];
    }>;
    evaluation: {
      overall: number;
      evidenceQuality: number;
      internalConsistency: number;
      specificity: number;
      corroboration: number;
    } | null;
  }>;
  evidence: Array<{
    id: string;
    type: string;
    source: string;
    title: string | null;
    reliability: number;
    retrievedAt: string;
  }>;
}

/** Why a job concluded what it did — the chain, not just the number. */
export interface Explanation {
  verdict: "SUPPORTED" | "DISPUTED" | "THIN" | "UNSUPPORTED";
  confidence: number;
  consensusScore: number;
  /** Kept apart because they fail independently; `outcome` is null until
   *  predictions have actually resolved. */
  reliability: { evidence: number; reasoning: number; outcome: number | null };
  claims: Array<{
    statement: string;
    kind: string;
    verdict: "SUPPORTED" | "DISPUTED" | "THIN" | "UNSUPPORTED";
    confidence: number;
    support: number;
    supportedBy: string[];
    contradictedBy: string[];
    evidenceQuality: number;
    evidence: Array<{
      source: string;
      title: string | null;
      reliability: number;
      stance: "supports" | "contradicts";
      curation: { upVotes: number; downVotes: number; approvalRate: number; epoch: number | null } | null;
    }>;
    reasons: string[];
  }>;
  reasons: string[];
  caveats: string[];
}

/**
 * Typed client for the Intelligence API.
 *
 * `runJob` is the primary entry point: it submits a job and resolves with the
 * finished intelligence, so a caller never has to write the polling loop or
 * reason about the lifecycle states themselves.
 */
export class AverisClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: AverisConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "http://localhost:4000").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async listDatanets(params: { search?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.limit) query.set("limit", String(params.limit));
    const { data } = await this.request<{ data: unknown[] }>(`/v1/datanets?${query}`);
    return data;
  }

  async getDatanet(id: string) {
    const { data } = await this.request<{ data: unknown }>(`/v1/datanets/${id}`);
    return data;
  }

  async listDatanetData(id: string, params: { limit?: number; page?: number } = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.page) query.set("page", String(params.page));
    const { data } = await this.request<{ data: unknown[] }>(`/v1/datanets/${id}/data?${query}`);
    return data;
  }

  /** The registry is shared across tenants: every caller sees every agent. */
  async listAgents() {
    const { data } = await this.request<{ data: unknown[] }>("/v1/agents");
    return data;
  }

  async getAgent(id: string) {
    const { data } = await this.request<{ data: unknown }>(`/v1/agents/${id}`);
    return data;
  }

  async registerAgent(input: RegisterAgentInput) {
    const { data } = await this.request<{ data: unknown }>("/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data;
  }

  /** Counts scoped the same way reads are: an account key sees its own jobs. */
  async getStats(): Promise<{
    jobs: number;
    resolved: number;
    activeAgents: number;
    evidenceItems: number;
  }> {
    const { data } = await this.request<{
      data: { jobs: number; resolved: number; activeAgents: number; evidenceItems: number };
    }>("/v1/stats");
    return data;
  }

  async createJob(input: CreateJobInput): Promise<JobSummary> {
    const { data } = await this.request<{ data: JobSummary }>("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data;
  }

  async getJob(id: string): Promise<JobSummary> {
    const { data } = await this.request<{ data: JobSummary }>(`/v1/jobs/${id}`);
    return data;
  }

  async listJobs(params: { status?: JobStatus; limit?: number } = {}): Promise<JobSummary[]> {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.limit) query.set("limit", String(params.limit));
    const { data } = await this.request<{ data: JobSummary[] }>(`/v1/jobs?${query}`);
    return data;
  }

  async getIntelligence(id: string): Promise<IntelligenceReport> {
    const { data } = await this.request<{ data: IntelligenceReport }>(
      `/v1/jobs/${id}/intelligence`,
    );
    return data;
  }

  /**
   * The reasoning behind a finished job: verdict, claims, and the upstream
   * curation numbers that gave each piece of evidence its weight.
   */
  async explain(id: string): Promise<{ summary: string; explanation: Explanation }> {
    const { data } = await this.request<{
      data: { summary: string; explanation: Explanation };
    }>(`/v1/jobs/${id}/explain`);
    return data;
  }

  /**
   * Submits a job and waits for it to reach a terminal state.
   *
   * Throws on FAILED rather than returning a partial result — a caller that
   * forgot to check `status` would otherwise act on intelligence that the
   * protocol declined to stand behind.
   */
  async runJob(
    input: CreateJobInput,
    options: { pollMs?: number; timeoutMs?: number; onStatus?: (s: JobStatus) => void } = {},
  ): Promise<IntelligenceReport> {
    const job = await this.createJob(input);
    const pollMs = options.pollMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);

    let last: JobStatus = job.status;
    options.onStatus?.(last);

    while (Date.now() < deadline) {
      const current = await this.getJob(job.id);
      if (current.status !== last) {
        last = current.status;
        options.onStatus?.(last);
      }
      if (current.status === "RESOLVED") return this.getIntelligence(job.id);
      if (current.status === "FAILED" || current.status === "CANCELLED") {
        throw new AverisError(
          409,
          `Job ${job.id} ended as ${current.status}: ${current.failureReason ?? "no reason given"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new AverisError(408, `Job ${job.id} did not resolve within the timeout`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...init.headers,
        },
      });

      const text = await response.text();
      const body: unknown = text ? JSON.parse(text) : {};

      if (response.status === 402) {
        throw new PaymentRequiredError(
          decodePaymentRequired(response.headers.get("payment-required")),
          body,
        );
      }

      if (!response.ok) {
        const message =
          (body as { error?: string }).error ?? `${response.status} ${response.statusText}`;
        throw new AverisError(response.status, message, body);
      }

      return body as T;
    } catch (error) {
      if (error instanceof AverisError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AverisError(408, `Request to ${path} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createClient(config?: AverisConfig): AverisClient {
  return new AverisClient(config);
}
