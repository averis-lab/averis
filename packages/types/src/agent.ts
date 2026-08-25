import { z } from "zod";
import { UnitInterval } from "./common";

export const AgentStatusSchema = z.enum(["ACTIVE", "PAUSED", "SUSPENDED", "RETIRED"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const CapabilitySchema = z.object({
  domain: z.string().min(1),
  skill: z.string().nullable().default(null),
  /** Self-declared proficiency. Selection corrects this with measured accuracy. */
  declared: UnitInterval.default(0.5),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const RegisterAgentSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().default(""),
  capabilities: z.array(CapabilitySchema).min(1),
  modelProvider: z.string().default("mock"),
  modelName: z.string().default("mock-analyst"),
  /** Tool allowlist — least privilege. An agent can only call what it declares. */
  tools: z.array(z.string()).default([]),
  runtimeConfig: z.record(z.string(), z.unknown()).default({}),
  pricePerJob: z.number().nonnegative().default(0),
  maxConcurrent: z.number().int().positive().max(50).default(3),
});
export type RegisterAgentInput = z.input<typeof RegisterAgentSchema>;

/** Everything the selector needs to score an agent against a job. */
export interface AgentDescriptor {
  id: string;
  name: string;
  status: AgentStatus;
  capabilities: Capability[];
  modelProvider: string;
  modelName: string;
  tools: string[];
  pricePerJob: number;
  maxConcurrent: number;
  /** Currently running assignments, used to respect concurrency limits. */
  activeAssignments: number;
  reputation: ReputationVector;
  /** Per-domain reputation, keyed by domain tag. */
  domainReputation: Record<string, ReputationVector>;
}

export interface ReputationVector {
  overall: number;
  accuracy: number;
  calibration: number;
  consistency: number;
  evidenceQuality: number;
  sampleSize: number;
}

export const NEUTRAL_REPUTATION: ReputationVector = {
  overall: 0.5,
  accuracy: 0.5,
  calibration: 0.5,
  consistency: 0.5,
  evidenceQuality: 0.5,
  sampleSize: 0,
};
