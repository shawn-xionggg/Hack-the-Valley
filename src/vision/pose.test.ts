import { describe, expect, it } from "vitest";
import type { Point, UtensilMarkerModel } from "../shared/config";
import type { DetectedMarker } from "./aruco";
import { applyHomography, calibrateMarker, invertHomography, markerHomography, parseUtensilModels, poseFromMarkers } from "./pose";

const LOCAL_CORNERS: Point[] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

/** A tag `side` frame-heights wide, centred at normalized (cx, cy), turned `deg`, corners in js-aruco2 order. */
function tag(id: number, cx: number, cy: number, side: number, deg = 0, aspect = 1): DetectedMarker {
  const r = deg * Math.PI / 180;
  return { id, corners: LOCAL_CORNERS.map(([x, y]) => [
    cx + (x * Math.cos(r) - y * Math.sin(r)) * side / aspect,
    cy + (x * Math.sin(r) + y * Math.cos(r)) * side,
  ] as Point) };
}

/** Where a marker-local point lands for a tag placed by `tag()` (a similarity transform, no perspective). */
function expected(local: Point, cx: number, cy: number, side: number, deg: number, aspect: number): Point {
  const r = deg * Math.PI / 180;
  const [x, y] = local;
  return [cx + (x * Math.cos(r) - y * Math.sin(r)) * side / aspect, cy + (x * Math.sin(r) + y * Math.cos(r)) * side];
}

const closeTo = (actual: Point | null | undefined, wanted: Point) => {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(wanted[0], 6);
  expect(actual![1]).toBeCloseTo(wanted[1], 6);
};

const model = (markerId: number, jaw: Point = [-4, 0]): UtensilMarkerModel => ({
  markerId,
  parts: { "tongs-tip": [[-4, -0.6], [-1, -0.6], [-1, 0.6], [-4, 0.6]], "tongs-handle": [[1, -0.6], [8, -0.6], [8, 0.6], [1, 0.6]] },
  tipContactPoints: [jaw],
});

describe("marker homography", () => {
  it("maps the marker-local square onto the detected corners, perspective included", () => {
    const corners: Point[] = [[0.2, 0.3], [0.35, 0.32], [0.33, 0.5], [0.18, 0.46]];
    const m = markerHomography(corners)!;
    LOCAL_CORNERS.forEach((local, i) => closeTo(applyHomography(m, local), corners[i]!));
  });

  it("inverts back to marker-local coordinates", () => {
    const m = markerHomography([[0.2, 0.3], [0.35, 0.32], [0.33, 0.5], [0.18, 0.46]])!;
    const inverse = invertHomography(m)!;
    for (const local of [[-4, 0.2], [0, 0], [7.5, -0.6]] as Point[]) closeTo(applyHomography(inverse, applyHomography(m, local)!), local);
  });

  it("rejects a degenerate quad", () => {
    expect(markerHomography([[0.1, 0.1], [0.1, 0.1], [0.1, 0.1], [0.1, 0.1]])).toBeNull();
    expect(markerHomography([[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]])).toBeNull();
  });
});

describe("tong calibration and pose", () => {
  it("places parts calibrated in one pose correctly after the tongs move, turn and change scale", () => {
    const aspect = 16 / 9;
    const at = tag(11, 0.5, 0.5, 0.05, 0, aspect);
    const jawImage = expected([-4, 0.1], 0.5, 0.5, 0.05, 0, aspect);
    const tipImage = ([[-4, -0.6], [-1, -0.6], [-1, 0.6], [-4, 0.6]] as Point[]).map(p => expected(p, 0.5, 0.5, 0.05, 0, aspect));
    const handleImage = ([[1, -0.6], [8, -0.6], [8, 0.6], [1, 0.6]] as Point[]).map(p => expected(p, 0.5, 0.5, 0.05, 0, aspect));
    const calibrated = calibrateMarker(11, at.corners, { "tongs-tip": tipImage, "tongs-handle": handleImage }, [jawImage])!;
    closeTo(calibrated.tipContactPoints[0], [-4, 0.1]);

    const pose = poseFromMarkers([tag(11, 0.3, 0.6, 0.06, 135, aspect)], { markers: [calibrated] }, aspect)!;
    expect(pose.markerId).toBe(11);
    closeTo(pose.tipContactPoints[0], expected([-4, 0.1], 0.3, 0.6, 0.06, 135, aspect));
    closeTo(pose.parts["tongs-handle"][2], expected([8, 0.6], 0.3, 0.6, 0.06, 135, aspect));
    expect(pose.markerSide).toBeCloseTo(0.06, 6);
  });

  it("uses the larger visible face and never averages the two", () => {
    const models = { markers: [model(11, [-4, 0]), model(12, [-3, 0])] };
    const pose = poseFromMarkers([tag(11, 0.3, 0.3, 0.04), tag(12, 0.6, 0.6, 0.05)], models, 1)!;
    expect(pose.markerId).toBe(12);
    closeTo(pose.tipContactPoints[0], [0.6 - 3 * 0.05, 0.6]);
  });

  it("ignores uncalibrated IDs and reports no pose without a calibrated marker", () => {
    const models = { markers: [model(11)] };
    expect(poseFromMarkers([tag(12, 0.5, 0.5, 0.05), tag(3, 0.2, 0.2, 0.08)], models, 1)).toBeNull();
    expect(poseFromMarkers([], models, 1)).toBeNull();
  });
});

describe("stored utensil models", () => {
  it("keeps valid entries, one per marker ID, and drops malformed ones", () => {
    const stale = model(11, [-2, 0]);
    const parsed = parseUtensilModels({ tongs: { markers: [stale, model(12), model(11), { markerId: 13, parts: {} }] } });
    expect(parsed.tongs?.markers.map(m => m.markerId)).toEqual([11, 12]);
    expect(parsed.tongs?.markers[0]!.tipContactPoints).toEqual([[-4, 0]]);
  });

  it("never reads a single-marker v1 model as a two-marker one", () => {
    expect(parseUtensilModels({ tongs: model(11) })).toEqual({});
    expect(parseUtensilModels(null)).toEqual({});
    expect(parseUtensilModels({ tongs: { markers: [] } })).toEqual({});
  });
});
