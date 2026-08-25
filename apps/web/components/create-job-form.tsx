"use client";

import { useActionState } from "react";
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
          minLength={8}
          rows={3}
          defaultValue={PRESETS[0].query}
          className="w-full resize-y rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent"
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
                (form.elements.namedItem("query") as HTMLTextAreaElement).value = preset.query;
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

      {state.status === "error" ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
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
