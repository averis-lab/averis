"use client";

import { useState, type KeyboardEvent } from "react";
import { ENDPOINTS, buildPath, toCurl, type PlaygroundEndpoint } from "@/lib/playground";

interface ApiResponse {
  status: number;
  statusText: string;
  durationMs: number;
  path: string;
  method: string;
  body: unknown;
}

const GROUPS = [...new Set(ENDPOINTS.map((endpoint) => endpoint.group))];

function toneFor(status: number): string {
  if (status === 0) return "border-red-500/40 bg-red-500/10 text-red-300";
  if (status < 300) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status < 500) return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-red-500/40 bg-red-500/10 text-red-300";
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

export function Playground() {
  const [selectedId, setSelectedId] = useState(ENDPOINTS[0]!.id);
  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<Record<string, string>>({});
  const [body, setBody] = useState(ENDPOINTS[0]!.body ?? "");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<"curl" | "sdk">("curl");

  // No useMemo: the React Compiler handles memoization here, and hand-written
  // memos it cannot preserve make it skip optimising the component entirely.
  const endpoint = ENDPOINTS.find((e) => e.id === selectedId) as PlaygroundEndpoint;

  // Switching endpoints resets the request: carrying a job id into an agent
  // lookup, or a stale body into a different schema, only ever produces a
  // confusing 400.
  const select = (id: string) => {
    const next = ENDPOINTS.find((e) => e.id === id)!;
    setSelectedId(id);
    setParams({});
    setQuery({});
    setBody(next.body ?? "");
    setResponse(null);
  };

  const { path, missing } = buildPath(endpoint, params, query);

  const send = async () => {
    setSending(true);
    try {
      const result = await fetch("/api/playground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpointId: endpoint.id, params, query, body }),
      });
      const parsed = (await result.json()) as ApiResponse & { error?: string };
      setResponse(
        parsed.error
          ? {
              status: result.status,
              statusText: "Rejected before sending",
              durationMs: 0,
              path,
              method: endpoint.method,
              body: { error: parsed.error },
            }
          : parsed,
      );
    } catch (error) {
      setResponse({
        status: 0,
        statusText: "Failed",
        durationMs: 0,
        path,
        method: endpoint.method,
        body: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSending(false);
    }
  };

  /** ⌘↵ from anywhere inside the panel, including the body editor. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (missing.length === 0 && !sending) void send();
    }
  };

  const curl = toCurl(endpoint, path, body);
  const rendered =
    response &&
    (typeof response.body === "string"
      ? response.body
      : JSON.stringify(response.body, null, 2));

  return (
    <div className="grid gap-5 lg:grid-cols-[236px_minmax(0,1fr)]" onKeyDown={onKeyDown}>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        {GROUPS.map((group) => (
          <div key={group} className="mb-4">
            <p className="mb-1.5 px-1 text-[10px] font-medium tracking-[0.14em] text-muted uppercase">
              {group}
            </p>
            <ul>
              {ENDPOINTS.filter((e) => e.group === group).map((e) => {
                const active = e.id === selectedId;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => select(e.id)}
                      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                        active ? "bg-surface text-foreground" : "text-muted hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`font-mono text-[10px] ${
                          e.method === "POST" ? "text-accent" : "text-muted"
                        }`}
                      >
                        {e.method}
                      </span>
                      <span className="truncate font-mono text-[11.5px]">{e.path}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </aside>

      <div className="min-w-0">
        <div className="rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                endpoint.method === "POST"
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-line text-muted"
              }`}
            >
              {endpoint.method}
            </span>
            <code className="font-mono text-sm">{endpoint.path}</code>
            {endpoint.writes ? (
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                changes state
              </span>
            ) : null}
            {endpoint.needsDb ? (
              <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted">
                needs Postgres
              </span>
            ) : null}
          </div>
          <p className="mt-2.5 text-sm leading-relaxed text-muted">{endpoint.summary}</p>

          {(endpoint.params?.length ?? 0) > 0 || (endpoint.query?.length ?? 0) > 0 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {endpoint.params?.map((field) => (
                <label key={field.name} className="block">
                  <span className="mb-1 block text-xs text-muted">
                    {field.label}
                    {field.required ? <span className="text-accent"> *</span> : null}
                  </span>
                  <input
                    value={params[field.name] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(e) => setParams({ ...params, [field.name]: e.target.value })}
                    className="w-full rounded-md border border-line bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent/60"
                  />
                </label>
              ))}
              {endpoint.query?.map((field) => (
                <label key={field.name} className="block">
                  <span className="mb-1 block text-xs text-muted">?{field.label}</span>
                  <input
                    value={query[field.name] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(e) => setQuery({ ...query, [field.name]: e.target.value })}
                    className="w-full rounded-md border border-line bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent/60"
                  />
                </label>
              ))}
            </div>
          ) : null}

          {endpoint.method === "POST" ? (
            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-muted">request body</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                rows={12}
                className="w-full resize-y rounded-md border border-line bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent/60"
              />
            </label>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || missing.length > 0}
              className="rounded-md bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            >
              {sending ? "Sending…" : "Send request"}
            </button>
            <span className="font-mono text-[11px] text-muted">
              {missing.length > 0 ? `needs ${missing.join(", ")}` : "⌘↵"}
            </span>
            <code className="ml-auto truncate font-mono text-[11px] text-muted">{path}</code>
          </div>
        </div>

        {response ? (
          <div className="mt-4 rounded-xl border border-line bg-surface">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${toneFor(response.status)}`}>
                {response.status === 0 ? "—" : response.status} {response.statusText}
              </span>
              <span className="font-mono text-[11px] text-muted">{response.durationMs}ms</span>
              <code className="truncate font-mono text-[11px] text-muted">
                {response.method} {response.path}
              </code>
              <span className="ml-auto">
                <CopyButton value={rendered ?? ""} />
              </span>
            </div>
            <pre className="max-h-[460px] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed">
              {rendered}
            </pre>
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-1 border-b border-line px-3 py-2">
            {(["curl", "sdk"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                  tab === key ? "bg-accent/10 text-accent" : "text-muted hover:text-foreground"
                }`}
              >
                {key}
              </button>
            ))}
            <span className="ml-auto">
              <CopyButton value={tab === "curl" ? curl : endpoint.sdk} />
            </span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-muted">
            {tab === "curl" ? curl : endpoint.sdk}
          </pre>
        </div>
      </div>
    </div>
  );
}
