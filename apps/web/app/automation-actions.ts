"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fetchJson, sendJson } from "@/lib/api";
import { viewerToken } from "@/lib/session";
import { AUTOMATION_ENABLED } from "@/lib/features";

export type DeployState = { status: "idle" } | { status: "error"; message: string };
export type ControlState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ok"; message: string };

/**
 * The feature gate, asserted per action.
 *
 * Every action in this file is its own POST endpoint, reachable whether or not
 * a page renders it. Gating only the routes would 404 the UI and leave the
 * feature callable, which is not a gate.
 */
function assertEnabled(): void {
  if (!AUTOMATION_ENABLED) throw new Error("Automation is not available yet.");
}

/**
 * Deploys an automation.
 *
 * Every numeric limit is clamped here rather than trusted from the form. A
 * Server Action is reachable by direct POST, and these particular numbers are
 * the ones that bound what the thing is allowed to risk.
 */
export async function deployAutomationAction(
  _previous: DeployState,
  formData: FormData,
): Promise<DeployState> {
  assertEnabled();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) {
    return { status: "error", message: "Give the automation a name you will recognise later." };
  }

  const capabilities = String(formData.get("capabilities") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  const policy = {
    minConfidence: clamp(formData.get("minConfidence"), 0, 1, 0.65),
    minConsensus: clamp(formData.get("minConsensus"), 0, 1, 0.6),
    minAgents: Math.round(clamp(formData.get("minAgents"), 1, 10, 3)),
    sizeUsd: clamp(formData.get("sizeUsd"), 1, 10_000, 25),
    maxConcurrentPositions: Math.round(clamp(formData.get("maxConcurrentPositions"), 1, 20, 3)),
    maxDeployedUsd: clamp(formData.get("maxDeployedUsd"), 1, 100_000, 100),
    takeProfitPct: clamp(formData.get("takeProfitPct"), 1, 1_000, 60),
    stopLossPct: clamp(formData.get("stopLossPct"), 1, 99, 25),
    maxHoldMinutes: Math.round(clamp(formData.get("maxHoldMinutes"), 1, 10_080, 240)),
    maxConsecutiveLosses: Math.round(clamp(formData.get("maxConsecutiveLosses"), 1, 20, 3)),
    maxDailyDrawdownUsd: clamp(formData.get("maxDailyDrawdownUsd"), 1, 100_000, 50),
  };

  let id: string;
  try {
    const created = await sendJson<{ data: { id: string } }>(
      "/v1/automations",
      "POST",
      { name, capabilities: capabilities.length > 0 ? capabilities : undefined, policy },
      undefined,
      await viewerToken(),
    );
    id = created.data.id;
  } catch (error) {
    return { status: "error", message: message(error) };
  }

  revalidatePath("/automation");
  // redirect() throws by design, so it sits outside the try block.
  redirect(`/automation/${id}`);
}

export async function setActiveAction(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  assertEnabled();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  try {
    await sendJson(`/v1/automations/${id}/active`, "POST", { active }, undefined, await viewerToken());
  } catch (error) {
    return { status: "error", message: message(error) };
  }
  revalidatePath(`/automation/${id}`);
  return {
    status: "ok",
    message: active
      ? "Started. New entries are allowed."
      : "Stopped. Open positions are still watched and exited.",
  };
}

export async function setModeAction(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  assertEnabled();
  const id = String(formData.get("id") ?? "");
  const mode = String(formData.get("mode") ?? "PAPER") === "LIVE" ? "LIVE" : "PAPER";
  try {
    await sendJson(`/v1/automations/${id}/mode`, "POST", { mode }, undefined, await viewerToken());
  } catch (error) {
    // The gateway's 501 explaining that no live driver exists is the useful
    // answer here, so it is surfaced verbatim rather than replaced.
    return { status: "error", message: message(error) };
  }
  revalidatePath(`/automation/${id}`);
  return { status: "ok", message: `Mode set to ${mode}.` };
}

export async function resetBreakerAction(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  assertEnabled();
  const id = String(formData.get("id") ?? "");
  try {
    await sendJson(
      `/v1/automations/${id}/reset-breaker`,
      "POST",
      {},
      undefined,
      await viewerToken(),
    );
  } catch (error) {
    return { status: "error", message: message(error) };
  }
  revalidatePath(`/automation/${id}`);
  return { status: "ok", message: "Breaker window moved forward. Trade history is unchanged." };
}

export type EvaluateState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "done";
      opened: boolean;
      message: string;
      gates: Array<{ gate: string; required: string; observed: string; passed: boolean }>;
    };

/**
 * Runs one finished job past the automation's policy.
 *
 * The same planner a live tick uses, so the gate list it returns is the real
 * decision rather than a preview of one.
 */
export async function evaluateJobAction(
  _previous: EvaluateState,
  formData: FormData,
): Promise<EvaluateState> {
  assertEnabled();
  const id = String(formData.get("id") ?? "");
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) return { status: "error", message: "Paste a resolved job id." };

  try {
    const result = await sendJson<{
      data: {
        decision: {
          open: boolean;
          message: string;
          gates: Array<{ gate: string; required: string; observed: string; passed: boolean }>;
        };
      };
    }>(
      `/v1/automations/${id}/evaluate`,
      "POST",
      { jobId },
      undefined,
      await viewerToken(),
    );

    revalidatePath(`/automation/${id}`);
    return {
      status: "done",
      opened: result.data.decision.open,
      message: result.data.decision.message,
      gates: result.data.decision.gates,
    };
  } catch (error) {
    return { status: "error", message: message(error) };
  }
}

export async function sweepAction(
  _previous: ControlState,
  formData: FormData,
): Promise<ControlState> {
  assertEnabled();
  const id = String(formData.get("id") ?? "");
  try {
    const result = await sendJson<{
      data: { checked: number; closed: number; unpriced: number };
    }>(
      `/v1/automations/${id}/sweep`,
      "POST",
      {},
      undefined,
      await viewerToken(),
    );
    revalidatePath(`/automation/${id}`);
    const { checked, closed, unpriced } = result.data;
    return {
      status: "ok",
      message:
        unpriced > 0
          ? `Marked ${checked - unpriced} of ${checked}, closed ${closed}. ${unpriced} could not be priced and were left open.`
          : `Marked ${checked}, closed ${closed}.`,
    };
  } catch (error) {
    return { status: "error", message: message(error) };
  }
}

/** Resolved jobs the operator can point the automation at. */
export async function recentResolvedJobs(): Promise<Array<{ id: string; query: string }>> {
  assertEnabled();
  try {
    const result = await fetchJson<{ data: Array<{ id: string; query: string }> }>(
      "/v1/jobs?status=RESOLVED&limit=8",
      undefined,
      await viewerToken(),
    );
    return result.data;
  } catch {
    return [];
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Could not reach the API gateway.";
}

function clamp(raw: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
