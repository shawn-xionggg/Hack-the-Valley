import type { Point, Polygon, ToolContactTarget, ToolSurface, UtensilMarkerModel, UtensilModel, UtensilModels } from "../shared/config";
import type { DetectedMarker } from "./aruco";
import { polygonArea } from "./geometry";

// Marker-relative tong geometry (spec A1 §4.4). Marker-local coordinates put the marker's black
// square at [-0.5, 0.5]^2, x toward corner 1 and y toward corner 3; js-aruco2 orders corners by
// the tag's own orientation, so these axes turn with the tongs.

/** Row-major 3×3 projective transform, scaled so the last entry is 1. */
export type Homography = readonly number[];

const TOOL_PARTS: readonly ToolSurface[] = ["tongs-tip", "tongs-handle"];
const TOOL_TARGETS: readonly ToolContactTarget[] = ["peanut-source", "meal-1"];

/** Maps marker-local points to normalized raw-frame points. Null for a degenerate quad. */
export function markerHomography(corners: readonly Point[]): Homography | null {
  const [p0, p1, p2, p3] = corners;
  if (corners.length !== 4 || !p0 || !p1 || !p2 || !p3) return null;
  // Unit square → quad (Heckbert): (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3.
  const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1], dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-12) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const a = p1[0] - p0[0] + g * p1[0], b = p3[0] - p0[0] + h * p3[0], c = p0[0];
  const d = p1[1] - p0[1] + g * p1[1], e = p3[1] - p0[1] + h * p3[1], f = p0[1];
  // Then shift marker-local [-0.5, 0.5] onto the unit square's [0, 1].
  return normalize([a, b, (a + b) / 2 + c, d, e, (d + e) / 2 + f, g, h, (g + h) / 2 + 1]);
}

function normalize(m: number[]): Homography | null {
  const last = m[8]!;
  if (Math.abs(last) < 1e-12 || m.some(n => !Number.isFinite(n))) return null;
  return m.map(n => n / last);
}

/** Null when the point maps to (or behind) the horizon, which a real tag never produces. */
export function applyHomography(m: Homography, [x, y]: Point): Point | null {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  if (w <= 1e-9) return null;
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
}

export function invertHomography(m: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return normalize([A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d]
    .map(n => n / det));
}

function mapAll(m: Homography, points: readonly Point[]): Point[] | null {
  const mapped: Point[] = [];
  for (const point of points) {
    const next = applyHomography(m, point);
    if (!next) return null;
    mapped.push(next);
  }
  return mapped;
}

/**
 * Stores parts drawn on the raw frame relative to the marker seen in that frame (H⁻¹ · points).
 * Calibrate each face separately: the two outlines are mirror images, never reuse one for the other.
 */
export function calibrateMarker(
  markerId: number, corners: readonly Point[], parts: Record<ToolSurface, Polygon>, tipContactPoints: Point[],
): UtensilMarkerModel | null {
  const forward = markerHomography(corners);
  const inverse = forward && invertHomography(forward);
  if (!inverse) return null;
  const tip = mapAll(inverse, parts["tongs-tip"]);
  const handle = mapAll(inverse, parts["tongs-handle"]);
  const points = mapAll(inverse, tipContactPoints);
  if (!tip || !handle || !points) return null;
  return { markerId, parts: { "tongs-tip": tip, "tongs-handle": handle }, tipContactPoints: points };
}

export interface UtensilPose {
  /** The marker the pose came from. */
  markerId: number;
  parts: Record<ToolSurface, Polygon>;
  tipContactPoints: Point[];
  /** Mean marker side in units of frame height: the scale for growing tool-contact zones, and the A4 height. */
  markerSide: number;
  /** A4: the placing face's touch references, in the same units as `markerSide`. Empty means no height gate. */
  touchSides: Partial<Record<ToolContactTarget, number>>;
}

/**
 * Places the utensil from ONE visible calibrated marker: the larger in the image if both faces
 * show (tongs on edge). Never averages them, since they sit on arms that move relative to each other.
 */
export function poseFromMarkers(markers: readonly DetectedMarker[], model: UtensilModel, aspect: number): UtensilPose | null {
  let best: { marker: DetectedMarker; entry: UtensilMarkerModel; area: number } | undefined;
  for (const marker of markers) {
    const entry = model.markers.find(m => m.markerId === marker.id);
    if (!entry || marker.corners.length !== 4) continue;
    const area = polygonArea(marker.corners);
    if (!best || area > best.area) best = { marker, entry, area };
  }
  if (!best) return null;
  const m = markerHomography(best.marker.corners);
  if (!m) return null;
  const tip = mapAll(m, best.entry.parts["tongs-tip"]);
  const handle = mapAll(m, best.entry.parts["tongs-handle"]);
  const points = mapAll(m, best.entry.tipContactPoints);
  if (!tip || !handle || !points) return null;
  const corners = best.marker.corners;
  const markerSide = corners.reduce((sum, [x, y], i) => {
    const [nx, ny] = corners[(i + 1) % 4]!;
    return sum + Math.hypot((nx - x) * aspect, ny - y);
  }, 0) / 4;
  return { markerId: best.entry.markerId, parts: { "tongs-tip": tip, "tongs-handle": handle }, tipContactPoints: points, markerSide,
    touchSides: best.entry.touchSides ?? {} };
}

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && value.every(n => typeof n === "number" && Number.isFinite(n));
const isPolygon = (value: unknown): value is Polygon => Array.isArray(value) && value.length >= 3 && value.every(isPoint);

function isMarkerModel(value: unknown): value is UtensilMarkerModel {
  if (!value || typeof value !== "object") return false;
  const { markerId, parts, tipContactPoints } = value as Record<string, unknown>;
  return Number.isInteger(markerId) && !!parts && typeof parts === "object" &&
    TOOL_PARTS.every(part => isPolygon((parts as Record<string, unknown>)[part])) &&
    Array.isArray(tipContactPoints) && tipContactPoints.length >= 1 && tipContactPoints.length <= 2 &&
    tipContactPoints.every(isPoint);
}

/**
 * A4: keeps only positive finite touch references. A malformed one is dropped on its own, which leaves that
 * target ungated (hover counts), and never drops the marker.
 */
function withValidTouchSides(entry: UtensilMarkerModel): UtensilMarkerModel {
  const { touchSides, ...rest } = entry;
  const raw: unknown = touchSides;
  if (!raw || typeof raw !== "object") return rest;
  const valid = TOOL_TARGETS.flatMap(target => {
    const side = (raw as Record<string, unknown>)[target];
    return typeof side === "number" && Number.isFinite(side) && side > 0 ? [[target, side] as const] : [];
  });
  return valid.length ? { ...rest, touchSides: Object.fromEntries(valid) } : rest;
}

/** Reads stored models (ghosttrace.utensils.v2). Anything malformed is dropped, which leaves the tongs "fixed". */
export function parseUtensilModels(value: unknown): UtensilModels {
  if (!value || typeof value !== "object") return {};
  const tongs = (value as Record<string, unknown>).tongs;
  if (!tongs || typeof tongs !== "object") return {};
  const markers = (tongs as Record<string, unknown>).markers;
  if (!Array.isArray(markers)) return {};
  // One entry per marker ID: the last calibration wins.
  const byId = new Map(markers.filter(isMarkerModel).map(entry => [entry.markerId, withValidTouchSides(entry)]));
  return byId.size ? { tongs: { markers: [...byId.values()] } } : {};
}
