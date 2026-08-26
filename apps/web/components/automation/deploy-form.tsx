"use client";

import { useActionState } from "react";
import { deployAutomationAction, type DeployState } from "@/app/automation-actions";

/**
 * Deploys an automation.
 *
 * Every field on this form is a ceiling, and the form says so: there is no
 * "expected return" input and no strategy preset that implies one. What an
 * operator configures here is how much they are willing to lose and how sure
 * the cohort has to be — the two things the protocol can actually enforce.
 */

const PRESETS = [
  {
    label: "Cautious",
    hint: "Only near-unanimous cohorts, small size",
    values: {
      minConfidence: 0.75,
      minConsensus: 0.7,
      minAgents: 4,
      sizeUsd: 10,
      maxConcurrentPositions: 2,
      maxDeployedUsd: 40,
      takeProfitPct: 50,
      stopLossPct: 20,
    },
  },
  {
    label: "Balanced",
    hint: "The defaults the policy schema ships with",
    values: {
      minConfidence: 0.65,
      minConsensus: 0.6,
      minAgents: 3,
      sizeUsd: 25,
      maxConcurrentPositions: 3,
      maxDeployedUsd: 100,
      takeProfitPct: 60,
      stopLossPct: 25,
    },
  },
  {
    label: "Wide",
    hint: "More candidates clear the gate, so more of them will be wrong",
    values: {
      minConfidence: 0.55,
      minConsensus: 0.5,
      minAgents: 3,
      sizeUsd: 25,
      maxConcurrentPositions: 5,
      maxDeployedUsd: 200,
      takeProfitPct: 80,
      stopLossPct: 30,
    },
  },
] as const;

const initial: DeployState = { status: "idle" };

export function DeployForm() {
  const [state, formAction, pending] = useActionState(deployAutomationAction, initial);

  return (
    <form action={formAction} className="space-y-5">
      <Field label="Name" hint="Shown on the dashboard and in the event log.">
        <input
          name="name"
          required
          minLength={2}
          maxLength={60}
          defaultValue="Memecoin scout"
          className={INPUT}
        />
      </Field>

      <Field
        label="Capabilities"
        hint="Which cohort's verdicts this automation acts on, comma separated."
      >
        <input name="capabilities" defaultValue="crypto, evm, markets" className={INPUT} />
      </Field>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            title={preset.hint}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-foreground"
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (!form) return;
              for (const [key, value] of Object.entries(preset.values)) {
                const field = form.elements.namedItem(key);
                if (field instanceof HTMLInputElement) field.value = String(value);
              }
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <Group title="Intelligence gate" note="Both floors must clear. A cohort can be confident and split, so one number could not stand for both.">
        <Number name="minConfidence" label="Min confidence" defaultValue={0.65} step={0.05} max={1} />
        <Number name="minConsensus" label="Min consensus" defaultValue={0.6} step={0.05} max={1} />
        <Number name="minAgents" label="Min agents reporting" defaultValue={3} step={1} max={10} />
      </Group>

      <Group title="Sizing" note="Ceilings, enforced before a position opens.">
        <Number name="sizeUsd" label="Size per position (USD)" defaultValue={25} step={1} />
        <Number name="maxConcurrentPositions" label="Max open positions" defaultValue={3} step={1} />
        <Number name="maxDeployedUsd" label="Max deployed (USD)" defaultValue={100} step={10} />
      </Group>

      <Group title="Exit" note="A position with no exit rule left is a bag, not a trade.">
        <Number name="takeProfitPct" label="Take profit %" defaultValue={60} step={5} />
        <Number name="stopLossPct" label="Stop loss %" defaultValue={25} step={5} max={99} />
        <Number name="maxHoldMinutes" label="Max hold (minutes)" defaultValue={240} step={30} />
      </Group>

      <Group title="Circuit breaker" note="Derived from trade history on every check, never a stored flag.">
        <Number name="maxConsecutiveLosses" label="Max consecutive losses" defaultValue={3} step={1} />
        <Number name="maxDailyDrawdownUsd" label="Max daily drawdown (USD)" defaultValue={50} step={10} />
      </Group>

      {state.status === "error" ? (
        <p className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-accent">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent-strong px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Deploying…" : "Deploy"}
        </button>
        <p className="text-[11px] text-muted">
          Deploys stopped, in paper mode. Starting it is a separate decision.
        </p>
      </div>
    </form>
  );
}

const INPUT =
  "w-full rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-muted/80">{hint}</p> : null}
    </div>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="rounded-xl border border-line p-4">
      <legend className="px-1.5 text-xs font-medium">{title}</legend>
      <p className="mb-3 text-[11px] leading-relaxed text-muted">{note}</p>
      <div className="grid gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Number({
  name,
  label,
  defaultValue,
  step,
  max,
}: {
  name: string;
  label: string;
  defaultValue: number;
  step: number;
  max?: number;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-[11px] text-muted">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        step={step}
        min={0}
        {...(max ? { max } : {})}
        defaultValue={defaultValue}
        className={`${INPUT} font-mono tabular-nums`}
      />
    </div>
  );
}
