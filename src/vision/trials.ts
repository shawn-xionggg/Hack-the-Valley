import { DEFAULT_TUNING, OBJECT_IDS, SURFACES } from "../shared/config";
import type { ContactTarget } from "../shared/config";
import type { ContactEvent, UtensilWashedEvent, WashEvent } from "../shared/events";

// Tallies rig trials from the dev page's "Export JSON" log. Events closer together than the
// attempt gap are treated as one physical attempt, so pause longer than the gap between attempts.

export type VisionEvent = ContactEvent | WashEvent | UtensilWashedEvent;
/**
 * What each attempt in a trial set should produce. "wash" = a hands-only wash; "utensil-washed" = the A3
 * `wash` + `utensil-washed` pair (set W3); "none" = nothing (e.g. brushing past the sink).
 */
export type TrialTarget = ContactTarget | "wash" | "utensil-washed" | "none";
const CONTACT_TARGETS = OBJECT_IDS.filter((id): id is ContactTarget => id !== "hands" && id !== "wash-station");
export const TRIAL_TARGETS: readonly TrialTarget[] = [...CONTACT_TARGETS, "wash", "utensil-washed", "none"];

/** "wrong-wash": a pair where a hands-only wash was expected (W5: it would clear tongs nobody washed), or the reverse. */
export type Outcome = "correct" | "fired-twice" | "wrong-tong-part" | "wrong-wash" | "unexpected";
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

/** Time order; a `utensil-washed` sorts after a `wash` at the same t, as vision emits them. */
const byTime = (a: VisionEvent, b: VisionEvent) =>
  a.t - b.t || Number(a.kind === "utensil-washed") - Number(b.kind === "utensil-washed");

/** Groups time-sorted events into attempts: a new attempt starts after a quiet gap of at least gapMs. */
export function clusterAttempts(events: VisionEvent[], gapMs = DEFAULT_ATTEMPT_GAP_MS): VisionEvent[][] {
  const clusters: VisionEvent[][] = [];
  let previous: number | undefined;
  for (const event of [...events].sort(byTime)) {
    if (previous === undefined || event.t - previous >= gapMs) clusters.push([]);
    clusters[clusters.length - 1]!.push(event);
    previous = event.t;
  }
  return clusters;
}

/** One physical result: an event, or an A3 `wash` directly followed by its `utensil-washed` (same t). */
type Unit = VisionEvent | { kind: "wash-pair"; t: number };

function pairWashes(cluster: VisionEvent[]): Unit[] {
  const units: Unit[] = [];
  for (const event of [...cluster].sort(byTime)) {
    const previous = units[units.length - 1];
    if (event.kind === "utensil-washed" && previous?.kind === "wash" && previous.t === event.t) {
      units[units.length - 1] = { kind: "wash-pair", t: event.t };
    } else units.push(event); // a lone utensil-washed breaks invariant 7, so it stays unexpected everywhere
  }
  return units;
}

const hits = (unit: Unit, expected: TrialTarget) =>
  expected === "wash" ? unit.kind === "wash"
  : expected === "utensil-washed" ? unit.kind === "wash-pair"
  : unit.kind === "contact" && unit.b === expected;

const isWrongWash = (unit: Unit, expected: TrialTarget) =>
  (expected === "wash" && unit.kind === "wash-pair") || (expected === "utensil-washed" && unit.kind === "wash");

const isOtherTongPart = (unit: Unit, expected: TrialTarget) => {
  if (unit.kind !== "contact" || unit.b === expected || expected === "wash" || expected === "utensil-washed" || expected === "none") return false;
  const utensil = SURFACES[expected].utensilId;
  return utensil !== undefined && SURFACES[unit.b].utensilId === utensil;
};

/**
 * Drops held re-fires: a contact for the same pair at least refireMs after the previous one is the
 * same touch still held. A real double fire needs exit + re-dwell (≥ 700 ms), so it lands sooner.
 */
function withoutHeldRefires(units: Unit[], refireMs: number): Unit[] {
  const last = new Map<string, number>();
  return units.filter(event => {
    if (event.kind !== "contact") return true;
    const key = `${event.a}>${event.b}`;
    const previous = last.get(key);
    last.set(key, event.t);
    return previous === undefined || event.t - previous < refireMs;
  });
}

/**
 * Worst problem wins: a tip/handle mix-up or the wrong kind of wash matters more than a stray zone, which
 * matters more than a double fire. A `wash` + `utensil-washed` pair counts as one wash.
 */
export function classifyAttempt(cluster: VisionEvent[], expected: TrialTarget,
  refireMs = DEFAULT_TUNING.heldContactRefireMs): Outcome {
  let units = pairWashes(cluster);
  const firstPair = units.findIndex(unit => unit.kind === "wash-pair");
  // A3 §4.4: if the jaw ends reached the sink after the hands, a hands-only wash fires first in the same visit.
  if (expected === "utensil-washed" && firstPair > 0) units = units.filter((unit, i) => i >= firstPair || unit.kind !== "wash");
  if (units.some(unit => isOtherTongPart(unit, expected))) return "wrong-tong-part";
  if (units.some(unit => isWrongWash(unit, expected))) return "wrong-wash";
  if (units.some(unit => !hits(unit, expected))) return "unexpected";
  return withoutHeldRefires(units, refireMs).length > 1 ? "fired-twice" : "correct";
}

export function tallyTrial(events: VisionEvent[], expected: TrialTarget, attempts: number | null = null,
  gapMs = DEFAULT_ATTEMPT_GAP_MS): TrialTally {
  const clusters = clusterAttempts(events, gapMs);
  const outcomes: Record<Outcome, number> = { correct: 0, "fired-twice": 0, "wrong-tong-part": 0, "wrong-wash": 0, unexpected: 0 };
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
