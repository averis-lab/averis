import { z } from "zod";

/**
 * Wire schemas for the Reppo Platform API.
 *
 * Verified against https://docs.reppo.ai/api/{datanets,pods}.md and against
 * live responses from https://reppo.ai/api/v1/public/*.
 *
 * Two things the docs do not spell out but the live API does:
 *  1. Every response is wrapped in a `{ "data": { … } }` envelope.
 *  2. `tokenId` is a string on subnets and a number on pods, so it is parsed
 *     leniently rather than pinned to one primitive.
 *
 * Every field is tolerant of absence: Reppo can add fields at any time and a
 * strict parse would take the whole intelligence layer down with it.
 */

const looseId = z.union([z.string(), z.number()]).nullish();

export const ReppoSubnetSchema = z.object({
  id: z.string(),
  subnetName: z.string().default(""),
  subnetDescription: z.string().nullish().default(""),
  thumbnailUrl: z.string().nullish().default(null),
  nativeTokenAddress: z.string().nullish().default(null),
  nativeTokenSymbol: z.string().nullish().default(null),
  nativeTokenDecimals: z.number().nullish().default(null),
  tokenId: looseId,
  accessFeeREPPO: z.number().nullish().default(0),
  emissionsPerEpochREPPO: z.number().nullish().default(0),
  emissionsPerEpochPrimaryToken: z.number().nullish().default(0),
  status: z.string().nullish().default("UNKNOWN"),
  upVoteVolume: z.number().nullish().default(0),
  downVoteVolume: z.number().nullish().default(0),
  onboardingPublishers: z.string().nullish().default(""),
  onboardingVoters: z.string().nullish().default(""),
  createdByUserId: z.string().nullish().default(null),
  chainId: z.number().nullish().default(null),
});
export type ReppoSubnet = z.infer<typeof ReppoSubnetSchema>;

export const ReppoPodCreatorSchema = z.object({
  id: z.string().nullish().default(null),
  username: z.string().nullish().default(null),
  avatarUrl: z.string().nullish().default(null),
  twitterHandle: z.string().nullish().default(null),
  isAgent: z.boolean().nullish().default(false),
});

export const ReppoPodSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  description: z.string().nullish().default(""),
  tokenId: looseId,
  privateSubnetId: z.string().nullish().default(null),
  url: z.string().nullish().default(null),
  imageUrl: z.string().nullish().default(null),
  thumbnailUrl: z.string().nullish().default(null),
  videoUrl: z.string().nullish().default(null),
  pdfUrl: z.string().nullish().default(null),
  creator: ReppoPodCreatorSchema.nullish().default(null),
  status: z.string().nullish().default(null),
  banned: z.boolean().nullish().default(false),
  banReason: z.string().nullish().default(null),
  podValidityEpoch: z.number().nullish().default(null),
  cumulativeUpVotesVolume: z.number().nullish().default(0),
  cumulativeDownVotesVolume: z.number().nullish().default(0),
  chainId: z.number().nullish().default(null),
  createdAt: z.string().nullish().default(null),
  updatedAt: z.string().nullish().default(null),
});
export type ReppoPod = z.infer<typeof ReppoPodSchema>;

/** `{ "data": { "subnets": [...] } }` */
export const SubnetListEnvelope = z.object({
  data: z.object({ subnets: z.array(ReppoSubnetSchema).default([]) }),
});
export const SubnetEnvelope = z.object({
  data: z.object({ subnet: ReppoSubnetSchema }),
});
export const PodListEnvelope = z.object({
  data: z.object({ pods: z.array(ReppoPodSchema).default([]) }),
});
export const PodEnvelope = z.object({
  data: z.object({ pod: ReppoPodSchema }),
});

/**
 * The authenticated `/me/*` surface.
 *
 * The public envelopes above were verified against live responses. These were
 * not: verifying them needs a Privy session for a real account, and none was
 * available. They are therefore written to accept either the documented
 * `{"data": {"subnets": [...]}}` envelope or a bare `{"data": [...]}` array,
 * and they degrade to an empty list rather than throwing when the shape is
 * neither — the same tolerance the public schemas already apply, for the same
 * reason.
 */
const meListOf = <T extends z.ZodTypeAny>(item: T, key: "subnets" | "pods") =>
  z.object({
    data: z.union([
      z.object({ [key]: z.array(item).default([]) }).transform((d) => d[key] as z.infer<T>[]),
      z.array(item),
    ]),
  });

export const MeSubnetListEnvelope = meListOf(ReppoSubnetSchema, "subnets");
export const MePodListEnvelope = meListOf(ReppoPodSchema, "pods");

/** Documented error shape: `{ "error": "Human-readable message" }` */
export const ReppoErrorEnvelope = z.object({ error: z.string() });
