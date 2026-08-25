/**
 * The endpoint catalogue behind /playground.
 *
 * This is deliberately a closed list rather than a free-form path field. The
 * browser never holds the gateway key — the proxy at `app/api/playground`
 * attaches it server-side — so a playground that forwarded an arbitrary path
 * would hand every visitor the server's credentials for any URL it can reach.
 * Requests name an entry in this catalogue; the proxy builds the path itself.
 *
 * Shared by the UI and the proxy so the two can never disagree about what is
 * allowed.
 */

export interface PlaygroundField {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

export interface PlaygroundEndpoint {
  id: string;
  method: "GET" | "POST";
  /** Path template; `:name` segments are filled from `params`. */
  path: string;
  group: string;
  summary: string;
  /** True when calling it changes state — the UI says so before you send. */
  writes?: boolean;
  /** True when the gateway needs Postgres to answer. */
  needsDb?: boolean;
  params?: PlaygroundField[];
  query?: PlaygroundField[];
  body?: string;
  /** The same call written against the SDK. */
  sdk: string;
}

export const ENDPOINTS: PlaygroundEndpoint[] = [
  {
    id: "health",
    method: "GET",
    path: "/health",
    group: "Service",
    summary: "Database, queue and data-provider status. The one endpoint that needs no key.",
    sdk: "await fetch(`${baseUrl}/health`).then((r) => r.json());",
  },
  {
    id: "stats",
    method: "GET",
    path: "/v1/stats",
    group: "Service",
    summary: "Counts, scoped the same way reads are: an account key sees only its own jobs.",
    needsDb: true,
    sdk: "await client.getStats();",
  },
  {
    id: "datanets.list",
    method: "GET",
    path: "/v1/datanets",
    group: "Datanets",
    summary: "Curated datasets upstream, with their curation health.",
    query: [
      { name: "search", label: "search", placeholder: "geopolitics" },
      { name: "limit", label: "limit", placeholder: "10" },
    ],
    sdk: 'await client.listDatanets({ limit: 10 });',
  },
  {
    id: "datanets.get",
    method: "GET",
    path: "/v1/datanets/:id",
    group: "Datanets",
    summary: "One datanet, including the rubric its owner published.",
    params: [{ name: "id", label: "datanet id", required: true }],
    sdk: 'await client.getDatanet("<id>");',
  },
  {
    id: "datanets.data",
    method: "GET",
    path: "/v1/datanets/:id/data",
    group: "Datanets",
    summary: "The highest-curated items in one datanet — the raw material evidence is drawn from.",
    params: [{ name: "id", label: "datanet id", required: true }],
    query: [{ name: "limit", label: "limit", placeholder: "5" }],
    sdk: 'await client.listDatanetData("<id>", { limit: 5 });',
  },
  {
    id: "jobs.create",
    method: "POST",
    path: "/v1/jobs",
    group: "Jobs",
    summary: "Create an intelligence job. This really runs a cohort and really spends budget.",
    writes: true,
    needsDb: true,
    body: JSON.stringify(
      {
        type: "dataset-evaluation",
        query: "Assess whether the curated corpus is reliable enough to act on",
        requiredCapabilities: ["markets", "research"],
        requiredAgents: 3,
        budget: 3,
        minimumConfidence: 0.4,
      },
      null,
      2,
    ),
    sdk: `await client.createJob({
  type: "dataset-evaluation",
  query: "Assess whether the curated corpus is reliable enough to act on",
  requiredCapabilities: ["markets", "research"],
  requiredAgents: 3,
  budget: 3,
});`,
  },
  {
    id: "jobs.list",
    method: "GET",
    path: "/v1/jobs",
    group: "Jobs",
    summary: "Your jobs, newest first.",
    needsDb: true,
    query: [
      { name: "status", label: "status", placeholder: "RESOLVED" },
      { name: "limit", label: "limit", placeholder: "10" },
    ],
    sdk: 'await client.listJobs({ status: "RESOLVED", limit: 10 });',
  },
  {
    id: "jobs.get",
    method: "GET",
    path: "/v1/jobs/:id",
    group: "Jobs",
    summary: "Status plus the full lifecycle audit trail — every transition, in order.",
    needsDb: true,
    params: [{ name: "id", label: "job id", required: true }],
    sdk: 'await client.getJob("<id>");',
  },
  {
    id: "jobs.intelligence",
    method: "GET",
    path: "/v1/jobs/:id/intelligence",
    group: "Jobs",
    summary: "The merged result: claims, the evidence behind each, disagreements, contributions.",
    needsDb: true,
    params: [{ name: "id", label: "job id", required: true }],
    sdk: 'await client.getIntelligence("<id>");',
  },
  {
    id: "jobs.explain",
    method: "GET",
    path: "/v1/jobs/:id/explain",
    group: "Jobs",
    summary:
      "Why the job concluded what it did — verdict, claims, and the upstream vote volumes behind each source.",
    needsDb: true,
    params: [{ name: "id", label: "job id", required: true }],
    sdk: 'await client.explain("<id>");',
  },
  {
    id: "agents.list",
    method: "GET",
    path: "/v1/agents",
    group: "Agents",
    summary: "The registry with measured reputation. Shared across tenants by design.",
    needsDb: true,
    sdk: "await client.listAgents();",
  },
  {
    id: "agents.get",
    method: "GET",
    path: "/v1/agents/:id",
    group: "Agents",
    summary: "One agent: capabilities, reputation snapshots, work completed.",
    needsDb: true,
    params: [{ name: "id", label: "agent id", required: true }],
    sdk: 'await client.getAgent("<id>");',
  },
  {
    id: "agents.register",
    method: "POST",
    path: "/v1/agents",
    group: "Agents",
    summary: "Register an agent. It starts at the neutral prior, not at zero.",
    writes: true,
    needsDb: true,
    body: JSON.stringify(
      {
        name: "Liquidity Risk Agent",
        description: "You are a DeFi liquidity risk specialist.",
        capabilities: [
          { domain: "defi", skill: "liquidity-analysis", declared: 0.9 },
          { domain: "crypto", declared: 0.7 },
        ],
        modelProvider: "mock",
        modelName: "mock-analyst",
        tools: ["reppo_search_data", "compute_evidence_stats"],
        pricePerJob: 0.5,
        maxConcurrent: 3,
      },
      null,
      2,
    ),
    sdk: `await client.registerAgent({
  name: "Liquidity Risk Agent",
  capabilities: [{ domain: "defi", declared: 0.9 }],
  modelProvider: "mock",
  modelName: "mock-analyst",
});`,
  },
];

export function findEndpoint(id: string): PlaygroundEndpoint | undefined {
  return ENDPOINTS.find((endpoint) => endpoint.id === id);
}

/**
 * Fills the path template and appends the allowed query keys.
 *
 * Values are encoded, and anything not declared on the endpoint is dropped —
 * a caller cannot smuggle in a segment or a parameter the catalogue does not
 * list.
 */
export function buildPath(
  endpoint: PlaygroundEndpoint,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): { path: string; missing: string[] } {
  const missing: string[] = [];

  const path = endpoint.path.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    const value = (params[name] ?? "").trim();
    if (!value) {
      missing.push(name);
      return `:${name}`;
    }
    return encodeURIComponent(value);
  });

  const search = new URLSearchParams();
  for (const field of endpoint.query ?? []) {
    const value = (query[field.name] ?? "").trim();
    if (value) search.set(field.name, value);
  }

  const suffix = search.toString();
  return { path: suffix ? `${path}?${suffix}` : path, missing };
}

/** The same request as a copy-pasteable curl invocation. */
export function toCurl(endpoint: PlaygroundEndpoint, path: string, body: string): string {
  const lines = [`curl ${endpoint.method === "POST" ? "-X POST " : ""}"$AVERIS_URL${path}"`];
  if (endpoint.path !== "/health") lines.push(`  -H "Authorization: Bearer $AVERIS_API_KEY"`);
  if (endpoint.method === "POST") {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${body.replace(/\n\s*/g, " ")}'`);
  }
  return lines.join(" \\\n");
}
