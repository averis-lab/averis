import { z } from "zod";
import { DomainTag, Timestamp, UnitInterval } from "./common";

/**
 * Provider-neutral view of an upstream curated dataset.
 *
 * Reppo calls this a "Datanet" in its docs and a "subnet" in its API; the
 * adapter normalizes both into this shape so the protocol core never depends
 * on Reppo-specific vocabulary.
 */
export const DatanetSchema = z.object({
  /** Upstream identifier, unique within the source. */
  id: z.string(),
  /** Which data network this came from, e.g. "reppo". */
  source: z.string(),
  name: z.string(),
  description: z.string().default(""),
  /** Domain tags inferred from the datanet, used for job → datanet matching. */
  domains: z.array(DomainTag).default([]),
  /** Aggregate curation signal from the upstream market. */
  curation: z
    .object({
      upVoteVolume: z.number().default(0),
      downVoteVolume: z.number().default(0),
      /** Up-vote share in [0,1]; 0.5 when there is no signal at all. */
      approvalRate: UnitInterval.default(0.5),
      status: z.string().default("UNKNOWN"),
    })
    .prefault({}),
  /**
   * The datanet's own published policy: what it considers good data, and how
   * it says contributions should be judged.
   *
   * This is free prose written by the datanet owner, not a machine-readable
   * spec, and it is **untrusted third-party text**. It is carried through so
   * agents can work to the domain's own standard instead of a generic one, but
   * it must never be spliced into a system prompt or into persistent state.
   */
  rubric: z
    .object({
      /** What contributors are told to submit. */
      publisherSpec: z.string().default(""),
      /** How the datanet says submissions should be scored. */
      voterRubric: z.string().default(""),
    })
    .prefault({}),
  /** Cost to access this datanet's data, in the upstream's own unit. */
  accessFee: z.number().default(0),
  thumbnailUrl: z.string().nullable().default(null),
  /** Untouched upstream payload, retained for provenance. */
  raw: z.unknown().optional(),
});
export type Datanet = z.infer<typeof DatanetSchema>;

/**
 * Provider-neutral view of one curated data item (a Reppo "pod").
 */
export const DataItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  datanetId: z.string().nullable().default(null),
  title: z.string(),
  /** Body text if the upstream carries one; otherwise the description. */
  content: z.string().default(""),
  url: z.string().nullable().default(null),
  /**
   * Normalized 0..1 quality derived from upstream curation. This is the
   * single number the intelligence layer trusts when weighting evidence —
   * how it is computed is the adapter's concern.
   */
  qualityScore: UnitInterval.default(0.5),
  curation: z
    .object({
      upVotes: z.number().default(0),
      downVotes: z.number().default(0),
      approvalRate: UnitInterval.default(0.5),
      epoch: z.number().nullable().default(null),
    })
    .prefault({}),
  author: z.string().nullable().default(null),
  publishedAt: Timestamp.nullable().default(null),
  raw: z.unknown().optional(),
});
export type DataItem = z.infer<typeof DataItemSchema>;

/** Search parameters understood by every data provider. */
export const DataQuerySchema = z.object({
  /** Free-text search passed to the upstream when it supports one. */
  text: z.string().optional(),
  /** Restrict to these datanet ids. */
  datanetIds: z.array(z.string()).optional(),
  /** Restrict to datanets carrying any of these domains. */
  domains: z.array(DomainTag).optional(),
  /** Drop items whose normalized quality falls below this floor. */
  minQuality: UnitInterval.optional(),
  limit: z.number().int().positive().max(200).default(25),
  page: z.number().int().positive().default(1),
});
export type DataQuery = z.input<typeof DataQuerySchema>;
export type ResolvedDataQuery = z.infer<typeof DataQuerySchema>;

/**
 * The single abstraction the rest of the system depends on.
 *
 * Everything above this line is Reppo-agnostic: swapping in another curated
 * data network means writing one more implementation of this interface.
 */
export interface DataProvider {
  /** Stable identifier for this provider, e.g. "reppo" or "fixture". */
  readonly name: string;

  listDatanets(page?: { page?: number; limit?: number; search?: string }): Promise<Datanet[]>;
  getDatanet(id: string): Promise<Datanet | null>;
  listData(datanetId: string, page?: { page?: number; limit?: number }): Promise<DataItem[]>;
  getData(dataId: string): Promise<DataItem | null>;
  searchData(query: DataQuery): Promise<DataItem[]>;
}

/** Kept as a named alias because the spec refers to it by this name. */
export type ReppoDataProvider = DataProvider;
