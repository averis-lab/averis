"use client";

import { useActionState, useState } from "react";
import { MIN_QUERY_CHARS, describeQueryProblem } from "@averis/types";
import { createJobAction, type CreateJobState } from "@/app/actions";

const PRESETS = [
  {
    label: "Evaluate corpus reliability",
    query:
      "Assess whether the curated geopolitical and market intelligence in these Datanets is reliable enough for an autonomous trading agent to act on.",
    capabilities: "markets, geopolitics, research",
    type: "dataset-evaluation",
  },
  {
    label: "Analyse tokenomics signal",
    query:
      "Analyse the quality and credibility of tokenomics and real-world-asset signals in the curated corpus for an autonomous allocator.",
    capabilities: "crypto, research",
    type: "asset-analysis",
  },
  {
    label: "Detect data-integrity risk",
    query:
      "Identify integrity risks, low-conviction items and possible manipulation in the curated corpus.",
    capabilities: "security, research",
    type: "anomaly-detection",
  },
];

const initial: CreateJobState = { status: "idle" };

export function CreateJobForm() {
  const [state, formAction, pending] = useActionState(createJobAction, initial);

  /*
   * The brief is controlled so it can be judged as it is typed.
   *
   * The same `describeQueryProblem` runs in the Server Action and again at the
   * gateway; running it here too is not a third rule but the same one, moved
   * to where it is cheap to satisfy. A requester finds out that four words is
   * not a brief while the cursor is still in the box, rather than after a
   * round trip that ends in a red box under a button.
   *
   * `touched` is what keeps that from being nagging: an empty form is not yet
   * wrong, so the complaint waits until there is something to complain about.
   */
  const [query, setQuery] = useState(PRESETS[0].query);
  const [touched, setTouched] = useState(false);

  const problem = describeQueryProblem(query);
  const showProblem = touched && problem !== null;
  // The server's own objection outranks ours — it saw the whole request.
  const message = state.status === "error" ? state.message : showProblem ? problem : null;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="query" className="mb-1.5 block text-xs font-medium text-muted">
          What intelligence do you want?
        </label>
        <textarea
          id="query"
          name="query"
          required
          minLength={MIN_QUERY_CHARS}
          rows={3}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showProblem || undefined}
          aria-describedby="query-problem"
          className={`w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none ${
            showProblem ? "border-red-500/50 focus:border-red-500" : "border-line focus:border-accent"
          }`}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="rounded-md border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-foreground"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form) return;
                // The brief is React state now; writing to the DOM node would
                // be overwritten on the next render.
                setQuery(preset.query);
                setTouched(false);
                (form.elements.namedItem("capabilities") as HTMLInputElement).value =
                  preset.capabilities;
                (form.elements.namedItem("type") as HTMLSelectElement).value = preset.type;
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="type" className="mb-1.5 block text-xs font-medium text-muted">
            Job type
          </label>
          <select
            id="type"
            name="type"
            defaultValue="dataset-evaluation"
            className="w-full rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {[
              "dataset-evaluation",
              "asset-analysis",
              "anomaly-detection",
              "market-research",
              "structured-research",
            ].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="capabilities" className="mb-1.5 block text-xs font-medium text-muted">
            Required capabilities
          </label>
          <input
            id="capabilities"
            name="capabilities"
            defaultValue="markets, geopolitics, research"
            className="w-full rounded-lg border border-line bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor="agents" className="mb-1.5 block text-xs font-medium text-muted">
            Agents
          </label>
          <input
            id="agents"
            name="agents"
            type="number"
            min={1}
            max={11}
            defaultValue={3}
            className="w-full rounded-lg border border-line bg-background px-3 py-2 font-mono text-sm tabular-nums outline-none focus:border-accent"
          />
        </div>
        <div>
          <label htmlFor="budget" className="mb-1.5 block text-xs font-medium text-muted">
            Budget (USDC)
          </label>
          <input
            id="budget"
            name="budget"
            type="number"
            min={0}
            step="0.5"
            defaultValue={3}
            className="w-full rounded-lg border border-line bg-background px-3 py-2 font-mono text-sm tabular-nums outline-none focus:border-accent"
          />
        </div>
        <div>
          <label htmlFor="minConfidence" className="mb-1.5 block text-xs font-medium text-muted">
            Min confidence
          </label>
          <input
            id="minConfidence"
            name="minConfidence"
            type="number"
            min={0}
            max={1}
            step="0.05"
            defaultValue={0.35}
            className="w-full rounded-lg border border-line bg-background px-3 py-2 font-mono text-sm tabular-nums outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* One slot for both objections, so a stale server error and a live one
          from the box above can never stack into two contradictory boxes. */}
      <p id="query-problem" role={message ? "alert" : undefined} aria-live="polite">
        {message ? (
          <span className="block rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500">
            {message}
          </span>
        ) : null}
      </p>

      <button
        type="submit"
        // Blocked on the brief, not merely discouraged. Submitting a query the
        // Server Action is certain to refuse spends a round trip to be told
        // something the page already knows.
        disabled={pending || problem !== null}
        onClick={() => setTouched(true)}
        className="w-full rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Dispatching to agent cohort…" : "Create intelligence job"}
      </button>
      <p className="text-[11px] leading-relaxed text-muted">
        The job is queued, matched to capability-appropriate agents, and each agent analyses the
        curated data independently before results are evaluated and merged.
      </p>
    </form>
  );
}
