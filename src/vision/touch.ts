import type { Polygon, ToolContactTarget, UtensilMarkerModel } from "../shared/config";
import type { DetectedMarker } from "./aruco";
import { poseFromMarkers } from "./pose";
import { jawsAtTarget } from "./tracker";

// Touch-reference capture (spec A4 §4.4 Tong calibration): one face's marker side, recorded while that
// face's jaw ends rest on a target. Pure, so it's tested without a camera; the dev page feeds it frames.

export const TOUCH_CAPTURE_MS = 1000;
export const TOUCH_CAPTURE_MIN_FRAMES = 10;
/** Largest (max − min) / min spread of the side over a capture: more means the tongs weren't at rest. */
export const TOUCH_CAPTURE_MAX_SPREAD = 0.05;

export interface TouchCapture { markerId: number; target: ToolContactTarget; startT: number; sides: number[] }
export type TouchCaptureResult = { done: false } | { done: true; side: number } | { done: true; error: string };

export function createTouchCapture(markerId: number, target: ToolContactTarget, t: number): TouchCapture {
  return { markerId, target, startT: t, sides: [] };
}

/**
 * Feeds one frame. Frames without this marker are skipped. A seen frame with no jaw end at the target refuses
 * the capture at once. After TOUCH_CAPTURE_MS it stores the LARGEST side seen: a bigger reference counts more
 * frames as touching, so capture noise errs toward exposure.
 */
export function addTouchFrame(
  capture: TouchCapture, markers: readonly DetectedMarker[], entry: UtensilMarkerModel, zone: Polygon, aspect: number, t: number,
): TouchCaptureResult {
  const pose = poseFromMarkers(markers, { markers: [entry] }, aspect);
  if (pose) {
    if (!jawsAtTarget(pose, zone, aspect)) return { done: true, error: "a jaw end left the target. Rest the jaw ends on it and keep still." };
    capture.sides.push(pose.markerSide);
  }
  if (t - capture.startT < TOUCH_CAPTURE_MS) return { done: false };
  if (capture.sides.length < TOUCH_CAPTURE_MIN_FRAMES) {
    return { done: true, error: `only ${capture.sides.length} frames showed ID ${capture.markerId} (need ${TOUCH_CAPTURE_MIN_FRAMES}).` };
  }
  const min = Math.min(...capture.sides), max = Math.max(...capture.sides);
  if ((max - min) / min > TOUCH_CAPTURE_MAX_SPREAD) return { done: true, error: "the marker size kept changing. Keep the tongs at rest." };
  return { done: true, side: max };
}
