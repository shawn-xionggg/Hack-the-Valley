import type { Point, Polygon, ZoneLayout, ZonedObjectId } from "../shared/config";
import { pointInPolygon } from "./tracker";

/** Unsigned shoelace area in normalized frame units (a full frame is 1). Winding order doesn't matter. */
export function polygonArea(polygon: Polygon): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!;
    const b = polygon[i]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** > 0 if o→a→b turns one way, < 0 the other, 0 if collinear. */
const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** q lies within the bounding box of segment p–r (only meaningful when the three are collinear). */
const within = (p: Point, q: Point, r: Point) =>
  Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
  Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);

/** True if segments a1–a2 and b1–b2 share any point, including touching endpoints and collinear overlap. */
export function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross(b1, b2, a1), d2 = cross(b1, b2, a2), d3 = cross(a1, a2, b1), d4 = cross(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && within(b1, a1, b2)) || (d2 === 0 && within(b1, a2, b2)) ||
    (d3 === 0 && within(a1, b1, a2)) || (d4 === 0 && within(a1, b2, a2));
}

/** At least 3 vertices and no two non-adjacent edges touch (rules out bowties and repeated vertices). */
export function isSimplePolygon(polygon: Polygon): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last edges share vertex 0
      if (segmentsIntersect(polygon[i]!, polygon[(i + 1) % n]!, polygon[j]!, polygon[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/** True if the two zones share any area or boundary: crossing edges, or one inside the other. */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return pointInPolygon(a[0]!, b) || pointInPolygon(b[0]!, a);
}

/** Every pair of calibrated zones that touch or share area. Unset (empty) zones never overlap. */
export function overlappingZones(zones: ZoneLayout): [ZonedObjectId, ZonedObjectId][] {
  const ids = Object.keys(zones) as ZonedObjectId[];
  const pairs: [ZonedObjectId, ZonedObjectId][] = [];
  ids.forEach((a, i) => ids.slice(i + 1).forEach(b => {
    if (polygonsOverlap(zones[a], zones[b])) pairs.push([a, b]);
  }));
  return pairs;
}

/** ≈ 11×11 px at 640×480. Smaller zones give choppy dwell counts because fingertip landmarks jitter by a few px. */
export const MIN_ZONE_AREA = 0.0004;
/** A zone over half the frame is almost always a mis-drawn outline and would turn every reach into a touch. */
export const MAX_ZONE_AREA = 0.5;

/**
 * Decides whether a freshly drawn zone can be saved. Returns null if it's acceptable,
 * otherwise a short message the calibration screen shows to the user.
 */
export function validatePolygon(polygon: Polygon): string | null {
  if (polygon.length < 3) return "Place at least 3 corners before finishing.";
  // Checked before area: a bowtie's shoelace area can come out near zero and would get the wrong message.
  if (!isSimplePolygon(polygon)) return "Edges cross or a corner repeats. Press Backspace to undo corners, then redraw.";
  const area = polygonArea(polygon);
  if (area < MIN_ZONE_AREA) return "Zone is too small to hold a fingertip reliably. Draw it larger.";
  if (area > MAX_ZONE_AREA) return "Zone covers over half the frame. Outline just the object.";
  return null;
}
