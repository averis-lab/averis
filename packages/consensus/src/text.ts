/**
 * Lexical primitives for recognizing when two agents said the same thing,
 * and when they said opposite things.
 *
 * This is deliberately a transparent heuristic rather than an embedding model:
 * consensus decisions must be reproducible and auditable years later, and a
 * remote embedding endpoint is neither. It sits behind `ClaimClusterer` so a
 * semantic implementation can replace it without touching the merge logic.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "of", "to",
  "in", "on", "for", "with", "that", "this", "it", "its", "as", "at", "by", "and",
  "or", "will", "may", "can", "has", "have", "had", "from", "into", "than", "then",
  "there", "their", "which", "while", "over", "under", "across", "within", "so",
]);

/** Words that flip the meaning of a statement. */
const NEGATORS = new Set(["not", "no", "never", "neither", "nor", "without", "cannot", "lacks", "lacking", "absent", "fails", "failed"]);

/** Directional sentiment markers used to detect opposing stances. */
const POSITIVE = new Set([
  "corroborate", "corroborated", "corroborates", "corroboration", "reliable", "reliability",
  "strong", "high", "healthy", "increase", "increases", "increasing", "growth", "positive",
  "safe", "secure", "confirm", "confirms", "confirmed", "supports", "supported", "above",
  "outperform", "improve", "improves", "improving", "consensus", "agree", "agrees", "sufficient",
]);

const NEGATIVE = new Set([
  "disagreement", "disagree", "disputed", "contested", "unreliable", "weak", "low", "poor",
  "decline", "declines", "declining", "decrease", "decreases", "negative", "risky", "unsafe",
  "vulnerable", "contradict", "contradicts", "refute", "refutes", "below", "underperform",
  "deteriorate", "stale", "insufficient", "inadequate", "concern", "concerns",
]);

/**
 * Light suffix stripping. Not a full stemmer — just enough that "curators",
 * "curator" and "curation" collapse together, which is what claim matching
 * actually needs.
 */
export function stem(token: string): string {
  let t = token;
  for (const suffix of ["ations", "ation", "ities", "ility", "ingly", "edly", "ing", "ies", "ied", "ers", "er", "ed", "es", "s", "ly"]) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  return t;
}

export function tokenize(statement: string): string[] {
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9\s.%-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Content tokens with numbers preserved — figures distinguish claims. */
export function contentSet(statement: string): Set<string> {
  return new Set(tokenize(statement).map(stem));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Stance of a statement: +1 asserts, -1 denies, 0 is neutral.
 * A negator inverts whatever sentiment follows it.
 */
export function polarity(statement: string): -1 | 0 | 1 {
  const tokens = tokenize(statement);
  let score = 0;
  let negated = false;

  for (const raw of tokens) {
    if (NEGATORS.has(raw)) {
      negated = true;
      score -= 1;
      continue;
    }
    const weight = POSITIVE.has(raw) ? 1 : NEGATIVE.has(raw) ? -1 : 0;
    if (weight !== 0) score += negated ? -weight : weight;
  }

  if (score > 0) return 1;
  if (score < 0) return -1;
  return 0;
}

/**
 * Topic similarity between two claims.
 *
 * Plain Jaccard is the wrong measure here: it punishes a claim for being more
 * detailed. "The signal is reliable" and "The signal is not reliable at 42.1%
 * approval" are unmistakably about the same topic, but their Jaccard is 0.375
 * purely because the second carries three extra tokens — and treating them as
 * unrelated would hide a real contradiction, the most damaging error this
 * function can make.
 *
 * So similarity is the better of two views:
 *   * Jaccard, for claims of comparable length;
 *   * containment (shared / smaller set), damped by the length ratio so a
 *     two-token fragment cannot match everything that happens to contain it.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (shared === 0) return 0;

  const smaller = Math.min(a.size, b.size);
  const larger = Math.max(a.size, b.size);

  const jaccardScore = shared / (a.size + b.size - shared);
  const containment = shared / smaller;
  const lengthDamping = Math.sqrt(smaller / larger);

  return Math.max(jaccardScore, containment * lengthDamping);
}
