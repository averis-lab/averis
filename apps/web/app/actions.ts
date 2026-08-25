"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export type CreateJobState =
  | { status: "idle" }
  | { status: "error"; message: string };

/**
 * Creates an intelligence job.
 *
 * Server Actions are reachable by direct POST, so the input is validated here
 * rather than relying on the form's own constraints.
 */
export async function createJobAction(
  _previous: CreateJobState,
  formData: FormData,
): Promise<CreateJobState> {
  const query = String(formData.get("query") ?? "").trim();
  if (query.length < 8) {
    return { status: "error", message: "Describe what intelligence you want in a little more detail." };
  }

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
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not reach the API gateway.",
    };
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
