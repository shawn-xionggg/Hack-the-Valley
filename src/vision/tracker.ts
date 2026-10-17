import { DEFAULT_TUNING } from "../shared/config";
import type { ContactTarget, Point, Polygon, Tuning, ZoneLayout } from "../shared/config";
import type { ContactEvent, VisionStatus, WashEvent } from "../shared/events";

export interface Landmark { x: number; y: number; z: number }

export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const TARGETS: ContactTarget[] = ["peanut-source", "tongs-tip", "tongs-handle", "meal-1"];
/** frames/hits count since entry, then since the last emission, so each re-fire reports its own window. */
interface Dwell { entered: number; lastInside: number; frames: number; hits: number; lastFired: number | undefined }

/** Marker tracking isn't built yet (spec v5 §4.6), so the tongs always use their calibrated fixed polygons. */
export function fixedUtensilStatus(zones: ZoneLayout): VisionStatus["utensils"] {
  return { tongs: { tracking: "fixed", parts: { "tongs-tip": zones["tongs-tip"], "tongs-handle": zones["tongs-handle"] }, lastSeenT: null } };
}

/** Converts normalized landmarks into the shared vision events; no exposure state lives here. */
export function createTracker(
  initialZones: ZoneLayout,
  onEvent: (event: ContactEvent | WashEvent) => void,
  options: Partial<Tuning> = {},
) {
  const tuning = { ...DEFAULT_TUNING, ...options };
  let zones = initialZones;
  const dwells = new Map<ContactTarget, Dwell>();
  let wash: { entered: number; lastInside: number; fired: boolean } | undefined;
  let previousTime: number | undefined;

  return {
    setZones(next: ZoneLayout) { zones = next; dwells.clear(); wash = undefined; },
    update(hands: Landmark[][], t: number, fps: number): VisionStatus {
      // Never count an unobserved camera stall as continuous contact or washing.
      if (previousTime !== undefined && t - previousTime > 500) { dwells.clear(); wash = undefined; }
      previousTime = t;
      const tips = hands.flatMap(hand => tuning.fingertipLandmarks.flatMap(i => hand[i] ? [hand[i]!] : []));
      const counts = new Map(TARGETS.map(id => [id, tips.filter(p => pointInPolygon([p.x, p.y], zones[id])).length]));
      // Prefer the tong surface with more fingertip overlap if their zones overlap.
      if (counts.get("tongs-tip")! > 0 && counts.get("tongs-handle")! > 0) {
        counts.set(counts.get("tongs-tip")! >= counts.get("tongs-handle")! ? "tongs-handle" : "tongs-tip", 0);
      }
      const activeZones = TARGETS.filter(id => counts.get(id)! > 0);
      for (const id of TARGETS) {
        const inside = activeZones.includes(id);
        let dwell = dwells.get(id);
        if (dwell && !inside && t - dwell.lastInside >= tuning.contactExitMs) {
          dwells.delete(id);
          continue;
        }
        if (!dwell && inside) {
          dwell = { entered: t, lastInside: t, frames: 0, hits: 0, lastFired: undefined };
          dwells.set(id, dwell);
        }
        if (!dwell) continue;
        dwell.frames++;
        if (inside) { dwell.hits++; dwell.lastInside = t; }
        // Re-fire while held: a grip that started clean must still pick up exposure that arrives later.
        const due = dwell.lastFired === undefined
          ? t - dwell.entered >= tuning.contactDwellMs
          : t - dwell.lastFired >= tuning.heldContactRefireMs;
        if (inside && due) {
          onEvent({ id: crypto.randomUUID(), t, kind: "contact", a: "hands", b: id,
            confidence: dwell.hits / dwell.frames, source: "camera" });
          dwell.lastFired = t;
          dwell.frames = 0;
          dwell.hits = 0;
        }
      }
      const inWash = hands.some(hand => hand.some(p => pointInPolygon([p.x, p.y], zones["wash-station"])));
      if (wash && !inWash && t - wash.lastInside >= 500) wash = undefined;
      if (inWash) {
        wash ??= { entered: t, lastInside: t, fired: false };
        wash.lastInside = t;
        if (!wash.fired && t - wash.entered >= tuning.washDwellMs) {
          wash.fired = true;
          onEvent({ id: crypto.randomUUID(), t, kind: "wash", method: "zone-dwell",
            durationMs: t - wash.entered, source: "camera", verified: false });
        }
      }
      return { t, handsVisible: hands.length, activeZones, fps,
        washProgress: wash ? Math.min(1, (t - wash.entered) / tuning.washDwellMs) : 0,
        activeToolContacts: [], utensils: fixedUtensilStatus(zones) };
    },
  };
}
