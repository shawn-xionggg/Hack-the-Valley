import { DEFAULT_TUNING } from "../shared/config";
import type { ContactTarget, Polygon, ToolContactTarget, ToolSurface, Tuning, UtensilModels, ZoneLayout } from "../shared/config";
import type { ContactEvent, UtensilPoseStatus, UtensilWashedEvent, VisionStatus, WashEvent } from "../shared/events";
import type { DetectedMarker } from "./aruco";
import { pointInPolygon, pointPolygonDistance } from "./geometry";
import { poseFromMarkers } from "./pose";
import type { UtensilPose } from "./pose";

export { pointInPolygon } from "./geometry";

export interface Landmark { x: number; y: number; z: number }

/** One frame's marker detections. `aspect` (width / height) keeps distances square on a 16:9 frame. */
export interface MarkerObservation { markers: DetectedMarker[]; aspect: number }

/**
 * Static targets are grown by this many marker sides before tool contacts are tested (§4.4: 1–2 cm;
 * 0.6 × a 25 mm tag ≈ 15 mm). Measured from the tag in view, so it scales with camera height.
 */
export const TOOL_ZONE_MARGIN = 0.6;

const TARGETS: ContactTarget[] = ["peanut-source", "tongs-tip", "tongs-handle", "meal-1"];
const TOOL_TARGETS: ToolContactTarget[] = ["peanut-source", "meal-1"];
type Pair = { a: "hands"; b: ContactTarget } | { a: ToolSurface; b: ToolContactTarget };
/** frames/hits count since entry, then since the last emission, so each re-fire reports its own window. */
interface Dwell { entered: number; lastInside: number; frames: number; hits: number; lastFired: number | undefined }

/** No marker model calibrated: the tongs use their static ZoneLayout polygons (v4 behaviour). */
export function fixedUtensilStatus(zones: ZoneLayout): VisionStatus["utensils"] {
  return { tongs: { tracking: "fixed", parts: { "tongs-tip": zones["tongs-tip"], "tongs-handle": zones["tongs-handle"] }, lastSeenT: null } };
}

/**
 * Jaw ends within the grown target zone, before the height gate. Jaw ends only (not the whole padded tip polygon). Amendment A2: the handle never acts in a tool contact,
 * because from overhead a handle above the bowl during a normal scoop looks the same as one resting in it.
 */
export function jawsAtTarget(pose: UtensilPose, target: Polygon, aspect: number): boolean {
  const margin = TOOL_ZONE_MARGIN * pose.markerSide;
  return pose.tipContactPoints.some(p => pointPolygonDistance(p, target, aspect) <= margin);
}

/**
 * A4 height gate: a marker more than `sideMargin` bigger than this face's touch reference for `b` is closer to
 * the camera than a touch, so the tips are carried above the target. No reference, no gate (hover counts).
 */
export function lowEnoughToTouch(pose: UtensilPose, b: ToolContactTarget, sideMargin: number): boolean {
  const reference = pose.touchSides[b];
  return reference === undefined || pose.markerSide <= reference * (1 + sideMargin);
}

/** Converts normalized landmarks and marker detections into the shared vision events; no exposure state lives here. */
export function createTracker(
  initialZones: ZoneLayout,
  onEvent: (event: ContactEvent | WashEvent | UtensilWashedEvent) => void,
  options: Partial<Tuning> = {},
  initialModels: UtensilModels = {},
) {
  const tuning = { ...DEFAULT_TUNING, ...options };
  let zones = initialZones;
  let models = initialModels;
  const dwells = new Map<string, Dwell>();
  /** Hand dwell for one sink visit. `utensilFired`: the wash + utensil-washed pair went out this visit. */
  let wash: { entered: number; lastInside: number; fired: boolean; utensilFired: boolean } | undefined;
  /**
   * A3 tong dwell, alive only inside a hand dwell. `lastPosed` is the last tracked or held frame down in the
   * sink, so only lost and (A4) raised frames count toward the utensilWashGapMs gap.
   */
  let utensilWash: { entered: number; lastPosed: number } | undefined;
  let previousTime: number | undefined;
  /** Last pose from a seen marker; reused while "held", dropped once "lost". */
  let pose: UtensilPose | undefined;
  let lastSeenT: number | null = null;

  /** Whenever the hand dwell resets, the tong dwell resets with it (§4.4). */
  function resetWash() { wash = undefined; utensilWash = undefined; }

  /** Advances one pair's dwell. `counted` frames make up confidence; held-pose frames for tools don't. */
  function step(pair: Pair, inside: boolean, counted: boolean, t: number) {
    const key = `${pair.a}>${pair.b}`;
    let dwell = dwells.get(key);
    if (dwell && !inside && t - dwell.lastInside >= tuning.contactExitMs) {
      dwells.delete(key);
      return;
    }
    if (!dwell && inside) {
      dwell = { entered: t, lastInside: t, frames: 0, hits: 0, lastFired: undefined };
      dwells.set(key, dwell);
    }
    if (!dwell) return;
    if (counted) dwell.frames++;
    if (inside) dwell.lastInside = t;
    if (inside && counted) dwell.hits++;
    // Re-fire while held: a grip that started clean must still pick up exposure that arrives later.
    const due = dwell.lastFired === undefined
      ? t - dwell.entered >= tuning.contactDwellMs
      : t - dwell.lastFired >= tuning.heldContactRefireMs;
    if (inside && due) {
      onEvent({ id: crypto.randomUUID(), t, kind: "contact", ...pair,
        confidence: dwell.frames ? dwell.hits / dwell.frames : 0, source: "camera" });
      dwell.lastFired = t;
      dwell.frames = 0;
      dwell.hits = 0;
    }
  }

  /** Tracking state for this frame (§4.4). Vision never invents a pose: no marker yet means "lost". */
  function trackUtensil(observation: MarkerObservation | undefined, t: number): UtensilPoseStatus {
    const model = models.tongs;
    if (!model?.markers.length) {
      pose = undefined;
      return fixedUtensilStatus(zones).tongs;
    }
    const seen = observation && poseFromMarkers(observation.markers, model, observation.aspect);
    if (seen) { pose = seen; lastSeenT = t; return { tracking: "tracked", parts: seen.parts, lastSeenT }; }
    if (pose && lastSeenT !== null && t - lastSeenT <= tuning.utensilHoldMs) {
      return { tracking: "held", parts: pose.parts, lastSeenT };
    }
    pose = undefined;
    return { tracking: "lost", parts: null, lastSeenT };
  }

  return {
    setZones(next: ZoneLayout) { zones = next; dwells.clear(); resetWash(); },
    setUtensilModels(next: UtensilModels) { models = next; pose = undefined; lastSeenT = null; dwells.clear(); utensilWash = undefined; },
    update(hands: Landmark[][], t: number, fps: number, observation?: MarkerObservation): VisionStatus {
      // Never count an unobserved camera stall as continuous contact or washing.
      if (previousTime !== undefined && t - previousTime > 500) { dwells.clear(); resetWash(); }
      previousTime = t;
      const tongs = trackUtensil(observation, t);
      // While lost, the tongs have no polygons at all, so no contact of any kind involves them.
      const polygons = (id: ContactTarget): Polygon =>
        id === "tongs-tip" || id === "tongs-handle" ? tongs.parts?.[id] ?? [] : zones[id];

      const tips = hands.flatMap(hand => tuning.fingertipLandmarks.flatMap(i => hand[i] ? [hand[i]!] : []));
      const counts = new Map(TARGETS.map(id => [id, tips.filter(p => pointInPolygon([p.x, p.y], polygons(id))).length]));
      // Prefer the tong surface with more fingertip overlap if their zones overlap.
      if (counts.get("tongs-tip")! > 0 && counts.get("tongs-handle")! > 0) {
        counts.set(counts.get("tongs-tip")! >= counts.get("tongs-handle")! ? "tongs-handle" : "tongs-tip", 0);
      }
      const activeZones = TARGETS.filter(id => counts.get(id)! > 0);
      for (const id of TARGETS) step({ a: "hands", b: id }, activeZones.includes(id), true, t);

      // Tool contacts only come from a tracked or held pose (invariant 9); confidence counts tracked frames.
      const activeToolContacts: VisionStatus["activeToolContacts"] = [];
      const current = tongs.tracking === "tracked" || tongs.tracking === "held" ? pose : undefined;
      for (const b of TOOL_TARGETS) {
        // A gated frame counts as outside, so a carry over the target is a pass and a descent starts a fresh dwell.
        const inside = !!current && jawsAtTarget(current, zones[b], observation?.aspect ?? 1)
          && lowEnoughToTouch(current, b, tuning.toolContactSideMargin);
        if (inside) activeToolContacts.push({ a: "tongs-tip", b });
        step({ a: "tongs-tip", b }, inside, tongs.tracking === "tracked", t);
      }

      const sink = zones["wash-station"];
      const inWash = hands.some(hand => hand.some(p => pointInPolygon([p.x, p.y], sink)));
      if (wash && !inWash && t - wash.lastInside >= 500) resetWash();
      if (inWash) {
        wash ??= { entered: t, lastInside: t, fired: false, utensilFired: false };
        wash.lastInside = t;
      }

      // A3 tong dwell. Plain containment, not the grown tool-contact zone: a clearing event stays conservative.
      // A4: jaw ends over the sink but above the peanut touch height (bowl and sink rims match) are "raised".
      // Lost and raised frames can only bridge a gap; it starts and fires on tracked frames down in the sink
      // (invariant 9: no invented pose).
      const overSink = !!current?.tipContactPoints.some(p => pointInPolygon(p, sink));
      const downInSink = overSink && lowEnoughToTouch(current!, "peanut-source", tuning.toolContactSideMargin);
      if (!wash || tongs.tracking === "fixed") utensilWash = undefined;
      else if (tongs.tracking === "lost" || (overSink && !downInSink)) {
        if (utensilWash && t - utensilWash.lastPosed > tuning.utensilWashGapMs) utensilWash = undefined;
      } else if (!overSink) utensilWash = undefined;
      else {
        // No restart after the pair fired: it can't fire again this visit, so its progress would mislead.
        if (tongs.tracking === "tracked" && !wash.utensilFired) utensilWash ??= { entered: t, lastPosed: t };
        if (utensilWash) utensilWash.lastPosed = t;
      }

      if (wash && inWash) {
        // Once per visit. The pair still fires after a hands-only wash, and replaces it when both are due.
        if (!wash.utensilFired && utensilWash && tongs.tracking === "tracked" && downInSink
          && t - utensilWash.entered >= tuning.washDwellMs) {
          wash.fired = wash.utensilFired = true;
          onEvent({ id: crypto.randomUUID(), t, kind: "wash", method: "zone-dwell",
            durationMs: t - wash.entered, source: "camera", verified: false });
          onEvent({ id: crypto.randomUUID(), t, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell",
            durationMs: t - utensilWash.entered, source: "camera", verified: false });
        } else if (!wash.fired && t - wash.entered >= tuning.washDwellMs) {
          wash.fired = true;
          onEvent({ id: crypto.randomUUID(), t, kind: "wash", method: "zone-dwell",
            durationMs: t - wash.entered, source: "camera", verified: false });
        }
      }
      return { t, handsVisible: hands.length, activeZones, fps,
        washProgress: wash ? Math.min(1, (t - wash.entered) / tuning.washDwellMs) : 0,
        utensilWashProgress: utensilWash ? Math.min(1, (t - utensilWash.entered) / tuning.washDwellMs) : 0,
        activeToolContacts, utensils: { tongs } };
    },
    /** Jaw ends of the current pose, for the debug overlay. Null unless tracked or held. */
    jawPoints() { return pose?.tipContactPoints ?? null; },
  };
}
