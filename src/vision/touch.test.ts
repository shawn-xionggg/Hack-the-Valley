import { describe, expect, it } from "vitest";
import type { Point, Polygon, UtensilMarkerModel } from "../shared/config";
import type { DetectedMarker } from "./aruco";
import { TOUCH_CAPTURE_MIN_FRAMES, addTouchFrame, createTouchCapture } from "./touch";
import type { TouchCaptureResult } from "./touch";

// The jaw end sits 4 tag widths left of a tag at the centre: (0.3, 0.5) for a 0.05 tag, inside the plate zone.
const tag = (id: number, side = 0.05, cx = 0.5): DetectedMarker => ({ id, corners: ([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as Point[])
  .map(([x, y]) => [cx + x * side, 0.5 + y * side] as Point) });
const entry: UtensilMarkerModel = { markerId: 11, tipContactPoints: [[-4, 0]],
  parts: { "tongs-tip": [[-4, -0.6], [-1, -0.6], [-1, 0.6], [-4, 0.6]], "tongs-handle": [[1, -0.6], [8, -0.6], [8, 0.6], [1, 0.6]] } };
const plate: Polygon = [[0.25, 0.45], [0.35, 0.45], [0.35, 0.55], [0.25, 0.55]];

/** Feeds one frame every 50 ms from 0 to 1000 ms and returns the first finished result. */
function capture(frame: (t: number) => DetectedMarker[]): TouchCaptureResult {
  const c = createTouchCapture(11, "meal-1", 0);
  for (let t = 0; t <= 1000; t += 50) {
    const result = addTouchFrame(c, frame(t), entry, plate, 1, t);
    if (result.done) return result;
  }
  return { done: false };
}

describe("touch-reference capture (A4)", () => {
  it("stores the largest side seen over a second at rest", () => {
    const result = capture(t => [tag(11, t % 100 ? 0.0505 : 0.05)]);
    expect(result.done && "side" in result && result.side).toBeCloseTo(0.0505, 6);
  });

  it("skips frames without that marker, and refuses too few of them", () => {
    const result = capture(t => t < 1000 - 50 * (TOUCH_CAPTURE_MIN_FRAMES - 2) ? [tag(12)] : [tag(11)]);
    expect(result).toMatchObject({ done: true, error: expect.stringContaining(`only ${TOUCH_CAPTURE_MIN_FRAMES - 1} frames`) });
  });

  it("refuses at once when a jaw end leaves the target", () => {
    const result = capture(t => [tag(11, 0.05, t >= 300 ? 0.8 : 0.5)]);
    expect(result).toMatchObject({ done: true, error: expect.stringContaining("left the target") });
  });

  it("refuses when the marker size keeps changing", () => {
    const result = capture(t => [tag(11, t < 500 ? 0.05 : 0.054)]);
    expect(result).toMatchObject({ done: true, error: expect.stringContaining("kept changing") });
  });
});
