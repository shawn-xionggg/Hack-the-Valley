import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Point, UtensilModels } from "../shared/config";
import type { VisionHandle, VisionOptions } from "../shared/vision-types";
import { createVideoMarkerDetector } from "./aruco";
import type { DetectedMarker, MarkerFrame } from "./aruco";
import { createTracker } from "./tracker";
import type { MarkerObservation } from "./tracker";

// Match the WASM runtime to the installed JavaScript package.
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export interface LiveVisionOptions extends VisionOptions {
  onResults?: (result: HandLandmarkerResult) => void;
  onError?: (error: unknown) => void;
  /** Every frame's tag detections (debug overlay, go/no-go trials). Turns detection on even without a tong model. */
  onMarkers?: (markers: DetectedMarker[], frame: MarkerFrame) => void;
  /** Jaw ends of the current tong pose, null unless tracked or held (debug overlay). */
  onJawPoints?: (points: Point[] | null) => void;
  /** Rig experiment: overrides the tracker's HAND_CONTACT_DWELL_MS. Tool contacts are unaffected. */
  handContactDwellMs?: number;
}

/** Call with a playing, unmirrored camera video. Coordinates remain in the raw frame. */
export async function startVision(options: LiveVisionOptions): Promise<VisionHandle> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const create = (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let model: HandLandmarker;
  try { model = await create("GPU"); }
  catch { model = await create("CPU"); }

  let models: UtensilModels = options.utensilModels ?? {};
  const tracker = createTracker(options.zones, options.onEvent,
    { ...options.tuning, ...(options.handContactDwellMs !== undefined && { handContactDwellMs: options.handContactDwellMs }) }, models);
  const markerDetector = createVideoMarkerDetector();
  let markerErrorLogged = false;
  let stopped = false;
  let animation = 0;
  let lastVideoTime = -1;
  let lastProcessed = -Infinity;
  let fpsStart = performance.now();
  let frames = 0;
  let fps = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animation);
    model.close();
    markerDetector.close();
  };
  /** Markers from the same frame as the hands. A failed detection counts as "no marker seen", so tracking goes lost. */
  const detectMarkers = (): MarkerObservation | undefined => {
    if (!models.tongs?.markers.length && !options.onMarkers) return undefined;
    try {
      const { markers, frame } = markerDetector.detect(options.video);
      options.onMarkers?.(markers, frame);
      return { markers, aspect: frame.width / frame.height };
    } catch (error) {
      if (!markerErrorLogged) { markerErrorLogged = true; console.error("ArUco detection failed; tong tracking will report lost.", error); }
      return undefined;
    }
  };
  const tick = () => {
    if (stopped) return;
    const t = performance.now();
    // Cap inference at 20 FPS and skip repeated video frames to keep the UI responsive.
    if (options.video.readyState >= 2 && options.video.currentTime !== lastVideoTime && t - lastProcessed >= 50) {
      lastVideoTime = options.video.currentTime;
      lastProcessed = t;
      try {
        const results = model.detectForVideo(options.video, t);
        const observation = detectMarkers();
        frames++;
        if (t - fpsStart >= 1000) { fps = Math.round(frames * 1000 / (t - fpsStart)); frames = 0; fpsStart = t; }
        options.onResults?.(results);
        const status = tracker.update(results.landmarks, t, fps, observation);
        options.onJawPoints?.(tracker.jawPoints());
        options.onStatus?.(status);
      } catch (error) { stop(); options.onError?.(error); return; }
    }
    animation = requestAnimationFrame(tick);
  };
  animation = requestAnimationFrame(tick);
  return {
    stop,
    setZones: tracker.setZones,
    setUtensilModels(next) { models = next; tracker.setUtensilModels(next); },
  };
}
