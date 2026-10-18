import { describe, expect, it } from "vitest";
import type { Point, Polygon, UtensilModels } from "../shared/config";
import type { DetectedMarker } from "./aruco";
import {
  CALIBRATION_STEPS, calibratedFacesText, demoLayout, emptyZones, finishCalibrationStep, finishZoneDraft, markerStatusText,
  touchCaptureFace, touchRefsText, withMarkerEntry, withTouchSide,
} from "./calibration";
import type { TongCalibration } from "./calibration";
import { overlappingZones, validatePolygon } from "./geometry";
import { poseFromMarkers } from "./pose";

const box = (x: number, y: number, w: number, h: number): Polygon => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
// A 0.05 tag centred at (0.5, 0.5); the jaw end drawn at (0.3, 0.5) sits 4 tag widths to its left.
const corners: Point[] = [[0.475, 0.475], [0.525, 0.475], [0.525, 0.525], [0.475, 0.525]];
const tag = (id: number): DetectedMarker => ({ id, corners });
const start = (markerId = 11): TongCalibration => ({ markerId, corners, step: "tongs-tip", parts: {} });

/** Runs a whole face calibration: tip, handle, then the jaw end. */
function calibrateFace(markerId: number) {
  const tip = finishCalibrationStep(start(markerId), box(0.28, 0.48, 0.15, 0.04));
  if (tip.kind !== "next") throw new Error(tip.kind);
  const handle = finishCalibrationStep(tip.calibration, box(0.55, 0.48, 0.3, 0.04));
  if (handle.kind !== "next") throw new Error(handle.kind);
  return { tip, handle, done: finishCalibrationStep(handle.calibration, [[0.3, 0.5]]) };
}

describe("zone calibration", () => {
  it("saves a valid outline and refuses one that can't hold a fingertip", () => {
    const saved = finishZoneDraft(emptyZones(), "meal-1", box(0.6, 0.6, 0.2, 0.2));
    expect(saved).toMatchObject({ message: "Meal for Order #4 saved. Select another surface to outline it." });
    expect("zones" in saved && saved.zones["meal-1"]).toEqual(box(0.6, 0.6, 0.2, 0.2));
    expect(finishZoneDraft(emptyZones(), "meal-1", [[0.1, 0.1], [0.2, 0.2]])).toEqual({ error: "Place at least 3 corners before finishing." });
  });

  it("saves an overlapping outline but warns, with the page's own names", () => {
    const zones = { ...emptyZones(), "tongs-tip": box(0.1, 0.1, 0.2, 0.1) };
    const result = finishZoneDraft(zones, "tongs-handle", box(0.25, 0.1, 0.2, 0.1), id => `<${id}>`);
    expect("message" in result && result.message).toBe(
      "⚠ <tongs-handle> saved, but it overlaps <tongs-tip>. Leave a gap over the hinge so tip and handle touches can't be confused.");
    expect(zones["tongs-handle"]).toEqual([]); // the input layout is never changed
  });

  it("lays out five valid, separate demo zones", () => {
    const zones = demoLayout();
    expect(Object.values(zones).map(validatePolygon)).toEqual([null, null, null, null, null]);
    expect(overlappingZones(zones)).toEqual([]);
  });
});

describe("tong face calibration", () => {
  it("steps tip → handle → jaw ends, then stores a model that places the jaw where it was clicked", () => {
    const { tip, handle, done } = calibrateFace(11);
    expect(tip.message).toBe(`ID 11: ${CALIBRATION_STEPS["tongs-handle"]}`);
    expect(handle.calibration.step).toBe("jaws");
    expect(done.kind).toBe("done");
    const entry = done.kind === "done" ? done.entry : null;
    const pose = poseFromMarkers([tag(11)], { markers: [entry!] }, 1);
    expect(pose!.tipContactPoints[0]![0]).toBeCloseTo(0.3, 6);
    expect(pose!.tipContactPoints[0]![1]).toBeCloseTo(0.5, 6);
  });

  it("warns when tip and handle overlap, and refuses bad outlines or no jaw end", () => {
    const tip = finishCalibrationStep(start(), box(0.28, 0.48, 0.3, 0.04));
    if (tip.kind !== "next") throw new Error(tip.kind);
    const handle = finishCalibrationStep(tip.calibration, box(0.5, 0.48, 0.3, 0.04));
    expect(handle.kind === "next" && handle.message).toMatch(/^ID 11: ⚠ Tip and handle overlap/);
    expect(finishCalibrationStep(start(), [[0.1, 0.1]])).toEqual({ kind: "error", message: "Place at least 3 corners before finishing." });
    if (handle.kind !== "next") throw new Error(handle.kind);
    expect(finishCalibrationStep(handle.calibration, [])).toEqual({ kind: "error", message: "ID 11: click at least one jaw end first." });
  });

  it("fails on a degenerate marker outline", () => {
    const flat: TongCalibration = { markerId: 12, corners: [[0.1, 0.1], [0.2, 0.1], [0.3, 0.1], [0.4, 0.1]], step: "jaws",
      parts: { "tongs-tip": box(0.1, 0.2, 0.1, 0.1), "tongs-handle": box(0.3, 0.2, 0.1, 0.1) } };
    expect(finishCalibrationStep(flat, [[0.1, 0.25]]).kind).toBe("failed");
  });

  it("replaces a recalibrated face and drops its touch heights (A4)", () => {
    const { done } = calibrateFace(11);
    if (done.kind !== "done") throw new Error(done.kind);
    const touched = withTouchSide(withMarkerEntry({}, done.entry), 11, "meal-1", 0.05);
    expect(touched.tongs!.markers[0]!.touchSides).toEqual({ "meal-1": 0.05 });
    expect(touchRefsText(touched)).toBe("11 plate ✓ peanut —");
    const again = withMarkerEntry(touched, done.entry);
    expect(again.tongs!.markers).toHaveLength(1);
    expect(again.tongs!.markers[0]!.touchSides).toBeUndefined();
    expect(calibratedFacesText(again)).toBe("11 ✓ · 12 —");
  });
});

describe("touch heights (A4)", () => {
  const { done } = calibrateFace(11);
  const models: UtensilModels = done.kind === "done" ? withMarkerEntry({}, done.entry) : {};
  const zones = { ...emptyZones(), "meal-1": box(0.25, 0.45, 0.1, 0.1) };

  it("records the visible calibrated face, once its target zone exists", () => {
    expect(touchCaptureFace([tag(11)], models, zones, "meal-1", 1)).toEqual({ markerId: 11 });
    expect(touchCaptureFace([tag(12)], models, zones, "meal-1", 1)).toMatchObject({ error: expect.stringMatching(/^No calibrated face is in view/) });
    expect(touchCaptureFace([tag(11)], models, zones, "peanut-source", 1, () => "Allergen source"))
      .toEqual({ error: "Calibrate the Allergen source zone first." });
  });

  it("reports each tag's size and its ratio to the recorded touch", () => {
    const touched = withTouchSide(models, 11, "meal-1", 0.05);
    expect(markerStatusText([tag(11)], { width: 1000, height: 1000, ms: 4 }, touched)).toBe("11 · 50 px · ×1.00 plate");
    expect(markerStatusText([tag(12)], { width: 500, height: 500, ms: 4 }, touched)).toBe("12 · 25 px ⚠");
    expect(markerStatusText([], { width: 500, height: 500, ms: 4 }, touched)).toBe("No markers visible");
  });
});
