"use client";

import { useActionState } from "react";
import {
  evaluateJobAction,
  resetBreakerAction,
  setActiveAction,
  setModeAction,
  sweepAction,
  type ControlState,
  type EvaluateState,
} from "@/app/automation-actions";

const idle: ControlState = { status: "idle" };

/**
 * The master switch.
 *
 * Deliberately says what stopping does *not* do. An operator who reads Stop as
 * "flatten everything" and walks away is the failure this label exists to
 * prevent — open positions keep being marked and exited by their own rules.
 */
export function StartStop({ id, active }: { id: string; active: boolean }) {
  const [state, formAction, pending] = useActionState(setActiveAction, idle);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <button
        type="submit"
        disabled={pending}
        className={`w-full rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50 ${
          active ? "bg-accent-strong text-white" : "border border-line text-foreground"
        }`}
      >
        {pending ? "…" : active ? "Stop" : "Start"}
      </button>
      <p className="text-[11px] leading-snug text-muted">
        {active
          ? "Stopping blocks new entries only. Open positions keep being watched and exited."
          : "Starting allows new entries. Nothing opens until a job clears every gate."}
      </p>
      <Result state={state} />
    </form>
  );
}

/**
 * Paper or live.
 *
 * The live option is rendered, not hidden, and the gateway refuses it with the
 * reason. Hiding it would leave an operator wondering whether they missed a
 * setting; showing the refusal states the project's position once, in the place
 * where it matters.
 */
export function ModeSwitch({
  id,
  mode,
  driverSpends,
}: {
  id: string;
  mode: "PAPER" | "LIVE";
  driverSpends: boolean;
}) {
  const [state, formAction, pending] = useActionState(setModeAction, idle);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <div className="flex gap-1.5">
        {(["PAPER", "LIVE"] as const).map((option) => (
          <button
            key={option}
            type="submit"
            name="mode"
            value={option}
            disabled={pending || (option === "LIVE" && !driverSpends)}
            className={`flex-1 rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              mode === option
                ? "border-accent bg-accent/10 text-foreground"
                : "border-line text-muted hover:text-foreground"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      {!driverSpends ? (
        <p className="text-[11px] leading-snug text-muted">
          No execution driver can spend real money, so live is unavailable. Paper positions are
          bookkeeping only — they resolve the cohort&apos;s calls without funding them.
        </p>
      ) : null}
      <Result state={state} />
    </form>
  );
}

export function SweepButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(sweepAction, idle);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-line px-3.5 py-2 text-sm transition-colors hover:border-accent disabled:opacity-50"
      >
        {pending ? "Marking…" : "Mark and sweep exits"}
      </button>
      <p className="text-[11px] leading-snug text-muted">
        Prices every open position and closes the ones whose rules fired. A position that cannot be
        priced is left open rather than marked to a guess.
      </p>
      <Result state={state} />
    </form>
  );
}

export function ResetBreaker({ id, reason }: { id: string; reason: string }) {
  const [state, formAction, pending] = useActionState(resetBreakerAction, idle);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <p className="text-sm font-medium text-amber-500">Circuit breaker tripped</p>
      <p className="text-xs leading-relaxed text-muted">{reason}</p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-500 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
      >
        {pending ? "…" : "Move the window forward"}
      </button>
      <p className="text-[11px] leading-snug text-muted">
        The breaker is derived from trade history, so it cannot be switched off. This moves the
        window it looks at; the trades that tripped it stay on the record.
      </p>
      <Result state={state} />
    </form>
  );
}

const evaluateIdle: EvaluateState = { status: "idle" };

/**
 * Runs one resolved job past the policy and shows every gate.
 *
 * The same planner a live tick calls, so this is the real decision rather than
 * a rehearsal of one — and when it opens a position, it has opened one.
 */
export function EvaluatePanel({
  id,
  jobs,
}: {
  id: string;
  jobs: Array<{ id: string; query: string }>;
}) {
  const [state, formAction, pending] = useActionState(evaluateJobAction, evaluateIdle);

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="id" value={id} />
        <input
          name="jobId"
          placeholder="Resolved job id"
          className="w-full rounded-lg border border-line bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
        {jobs.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                title={job.query}
                className="max-w-full truncate rounded-md border border-line px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:border-accent hover:text-foreground"
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  const field = form?.elements.namedItem("jobId");
                  if (field instanceof HTMLInputElement) field.value = job.id;
                }}
              >
                {job.id.slice(0, 10)}…
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-line px-3 py-1.5 text-xs transition-colors hover:border-accent disabled:opacity-50"
        >
          {pending ? "Evaluating…" : "Run this job past the policy"}
        </button>
      </form>

      {state.status === "error" ? (
        <p className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-accent">
          {state.message}
        </p>
      ) : null}

      {state.status === "done" ? (
        <div className="space-y-2">
          <p
            className={`text-xs leading-relaxed ${state.opened ? "text-emerald-500" : "text-muted"}`}
          >
            {state.opened ? "Opened a position. " : "No position. "}
            {state.message}
          </p>
          {state.gates.length > 0 ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {state.gates.map((gate) => (
                <li
                  key={gate.gate}
                  className="flex items-baseline gap-2 px-3 py-1.5 font-mono text-[11px]"
                >
                  <span className={gate.passed ? "text-emerald-500" : "text-accent"}>
                    {gate.passed ? "pass" : "fail"}
                  </span>
                  <span className="text-foreground">{gate.gate}</span>
                  <span className="ml-auto text-right text-muted">
                    {gate.observed} <span className="text-muted/60">/ {gate.required}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Result({ state }: { state: ControlState }) {
  if (state.status === "idle") return null;
  return (
    <p
      className={`text-[11px] leading-snug ${
        state.status === "error" ? "text-accent" : "text-muted"
      }`}
    >
      {state.message}
    </p>
  );
}
