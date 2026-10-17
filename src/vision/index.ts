import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type { VisionHandle, VisionOptions } from "../shared/vision-types";
import { createTracker } from "./tracker";

// Match the WASM runtime to the installed JavaScript package.
const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export interface LiveVisionOptions extends VisionOptions {
  onResults?: (result: HandLandmarkerResult) => void;
  onError?: (error: unknown) => void;
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

  const tracker = createTracker(options.zones, options.onEvent, options.tuning);
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
        frames++;
        if (t - fpsStart >= 1000) { fps = Math.round(frames * 1000 / (t - fpsStart)); frames = 0; fpsStart = t; }
        options.onResults?.(results);
        options.onStatus?.(tracker.update(results.landmarks, t, fps));
      } catch (error) { stop(); options.onError?.(error); return; }
    }
    animation = requestAnimationFrame(tick);
  };
  animation = requestAnimationFrame(tick);
  return { stop, setZones: tracker.setZones };
}
