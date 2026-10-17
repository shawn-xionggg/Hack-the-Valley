import { OBJECT_IDS, SURFACES } from "../shared/config";
import type { ContactTarget } from "../shared/config";
import type { ContactEvent, WashEvent } from "../shared/events";

// Tallies rig trials from the dev page's "Export JSON" log. Events closer together than the
// attempt gap are treated as one physical attempt, so pause longer than the gap between attempts.

export type VisionEvent = ContactEvent | WashEvent;
/** What each attempt in a trial set should produce. "none" = nothing (e.g. brushing past the wash station). */
export type TrialTarget = ContactTarget | "wash" | "none";
const CONTACT_TARGETS = OBJECT_IDS.filter((id): id is ContactTarget => id !== "hands" && id !== "wash-station");
export const TRIAL_TARGETS: readonly TrialTarget[] = [...CONTACT_TARGETS, "wash", "none"];

export type Outcome = "correct" | "fired-twice" | "wrong-tong-part" | "unexpected";
export const DEFAULT_ATTEMPT_GAP_MS = 1500;

export interface TrialTally {
  expected: TrialTarget;
  attempts: number | null;
  /** Attempts that produced at least one event. */
  registered: number;
  outcomes: Record<Outcome, number>;
  /** attempts − registered, when the attempt count is known. */
  missed: number | null;
  /** Confidence of the contacts that hit the expected zone. */
  confidence: { min: number; mean: number } | null;
}

/** Groups time-sorted events into attempts: a new attempt starts after a quiet gap of at least gapMs. */
export function clusterAttempts(events: VisionEvent[], gapMs = DEFAULT_ATTEMPT_GAP_MS): VisionEvent[][] {
  const clusters: VisionEvent[][] = [];
  let previous: number | undefined;
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (previous === undefined || event.t - previous >= gapMs) clusters.push([]);
    clusters[clusters.length - 1]!.push(event);
    previous = event.t;
  }
  return clusters;
}

const hits = (event: VisionEvent, expected: TrialTarget) =>
  expected === "wash" ? event.kind === "wash" : event.kind === "contact" && event.b === expected;

const isOtherTongPart = (event: VisionEvent, expected: TrialTarget) => {
  if (event.kind !== "contact" || event.b === expected || expected === "wash" || expected === "none") return false;
  const utensil = SURFACES[expected].utensilId;
  return utensil !== undefined && SURFACES[event.b].utensilId === utensil;
};

/** Worst problem wins: a tip/handle mix-up matters more than a stray zone, which matters more than a double fire. */
export function classifyAttempt(cluster: VisionEvent[], expected: TrialTarget): Outcome {
  if (cluster.some(event => isOtherTongPart(event, expected))) return "wrong-tong-part";
  if (cluster.some(event => !hits(event, expected))) return "unexpected";
  return cluster.length > 1 ? "fired-twice" : "correct";
}

export function tallyTrial(events: VisionEvent[], expected: TrialTarget, attempts: number | null = null,
  gapMs = DEFAULT_ATTEMPT_GAP_MS): TrialTally {
  const clusters = clusterAttempts(events, gapMs);
  const outcomes: Record<Outcome, number> = { correct: 0, "fired-twice": 0, "wrong-tong-part": 0, unexpected: 0 };
  for (const cluster of clusters) outcomes[classifyAttempt(cluster, expected)]++;
  const confidences = events.flatMap(event => event.kind === "contact" && event.b === expected ? [event.confidence] : []);
  return {
    expected,
    attempts,
    registered: clusters.length,
    outcomes,
    missed: attempts === null || expected === "none" ? null : Math.max(0, attempts - clusters.length),
    confidence: confidences.length
      ? { min: Math.min(...confidences), mean: confidences.reduce((sum, c) => sum + c, 0) / confidences.length }
      : null,
  };
}
