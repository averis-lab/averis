"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AverisError } from "@averis/sdk";
import { describeQueryProblem, normalizeQuery } from "@averis/types";
import { api } from "@/lib/api";

export type CreateJobState =
  | { status: "idle" }
  | { status: "error"; message: string };

/**
 * Creates an intelligence job.
 *
 * Server Actions are reachable by direct POST, so the input is validated here
 * rather than relying on the form's own constraints. The rule itself lives in
 * `@averis/types` and is the same one the gateway applies — the form checks it
 * as you type, this checks it before spending a round trip, and the API checks
 * it because neither of the first two is reachable by a script.
 */
export async function createJobAction(
  _previous: CreateJobState,
  formData: FormData,
): Promise<CreateJobState> {
  const query = normalizeQuery(String(formData.get("query") ?? ""));
  const problem = describeQueryProblem(query);
  if (problem) return { status: "error", message: problem };

  const capabilities = String(formData.get("capabilities") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  const agents = clampInt(formData.get("agents"), 1, 11, 3);
  const budget = clampNumber(formData.get("budget"), 0, 1_000, 3);
  const minConfidence = clampNumber(formData.get("minConfidence"), 0, 1, 0.35);

  let jobId: string;
  try {
    const job = await api.createJob({
      type: String(formData.get("type") ?? "dataset-evaluation"),
      query,
      requiredCapabilities: capabilities,
      requiredAgents: agents,
      budget,
      minimumConfidence: minConfidence,
      deadline: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    jobId = job.id;
  } catch (error) {
    /*
     * A duplicate is not a failure, so it does not render as one.
     *
     * The gateway answers 409 with the id of the job that already asks this,
     * which is exactly where the requester wanted to end up — they pressed the
     * button twice because they could not tell whether the first press worked.
     * Sending them to the answer is a better reply than telling them off.
     *
     * The id is only *captured* here; the redirect happens below, outside the
     * try/catch, for the same reason the success path does.
     */
    const existing =
      error instanceof AverisError && error.status === 409
        ? (error.detail as { existingJobId?: string } | undefined)?.existingJobId
        : undefined;
    if (!existing) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Could not reach the API gateway.",
      };
    }
    jobId = existing;
  }

  revalidatePath("/dashboard");
  // redirect() throws by design, so it must sit outside the try block.
  redirect(`/jobs/${jobId}`);
}

function clampInt(raw: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const value = Math.round(Number(raw));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampNumber(raw: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
