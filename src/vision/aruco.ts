import { AR } from "js-aruco2";
import "js-aruco2/src/dictionaries/aruco_4x4_1000.js";
import type { Point } from "../shared/config";

// OpenCV's 4x4 dictionaries share their first codes. Restrict IDs to the first 50.
AR.DICTIONARIES.ARUCO_4X4_50 = {
  nBits: 16, tau: 2, codeList: AR.DICTIONARIES.ARUCO_4X4_1000!.codeList.slice(0, 50),
};
export type MarkerDictionary = "ARUCO_4X4_50" | "ARUCO_MIP_36h12" | "ARUCO";
export const DEFAULT_MARKER_DICTIONARY: MarkerDictionary = "ARUCO_4X4_50";

export interface DetectedMarker {
  id: number;
  /** Ordered corners in normalized RAW camera coordinates, before display mirroring. */
  corners: Point[];
}


const outlines: Record<number, Point[]> = {
  11: [ // First jaw — rotated 270° clockwise from the original outline
    [-3.5,  0.6],
    [-3.5, -0.6],
    [ 1.0, -0.6],
    [ 1.0,  0.6],
  ],
  12: [ // Second jaw — rotated 270° clockwise from the original outline
    [-3.5,  0.6],
    [-3.5, -0.6],
    [ 1.0, -0.6],
    [ 1.0,  0.6],
  ],
};

// Handle regions follow the jaw tags, extending along each marker's positive X axis.
const handleOutlines: Record<number, Point[]> = {
  11: [
    [0.8,  0.6],
    [0.8, -0.6],
    [8.0, -0.6],
    [8.0,  0.6],
  ],
  12: [
    [0.8,  0.6],
    [0.8, -0.6],
    [8.0, -0.6],
    [8.0,  0.6],
  ],
};

function projectOutline(
  marker: DetectedMarker,
  outline: Point[],
): Point[] {
  const [p0, p1, p2, p3] = marker.corners;
  if (!p0 || !p1 || !p2 || !p3) return [];

  const dx1 = p1[0] - p2[0];
  const dx2 = p3[0] - p2[0];
  const dx3 = p0[0] - p1[0] + p2[0] - p3[0];

  const dy1 = p1[1] - p2[1];
  const dy2 = p3[1] - p2[1];
  const dy3 = p0[1] - p1[1] + p2[1] - p3[1];

  let g = 0;
  let h = 0;

  if (Math.abs(dx3) + Math.abs(dy3) > 1e-10) {
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-10) return [];

    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }

  const a = p1[0] - p0[0] + g * p1[0];
  const b = p3[0] - p0[0] + h * p3[0];
  const d = p1[1] - p0[1] + g * p1[1];
  const e = p3[1] - p0[1] + h * p3[1];

  const result: Point[] = [];

  for (const [x, y] of outline) {
    const u = x + 0.5;
    const v = y + 0.5;
    const denominator = g * u + h * v + 1;

    if (denominator <= 1e-8) return [];

    result.push([
      (a * u + b * v + p0[0]) / denominator,
      (d * u + e * v + p0[1]) / denominator,
    ]);
  }

  return result;
}

export function createMarkerDetector(dictionary: MarkerDictionary = DEFAULT_MARKER_DICTIONARY) {
  const detector = new AR.Detector({ dictionaryName: dictionary, maxHammingDistance: 2 });
  return {
    detect(image: { width: number; height: number; data: Uint8ClampedArray }): DetectedMarker[] {
      return detector.detect(image).filter(marker => marker.id !== 10).map(marker => ({
        id: marker.id,
        corners: marker.corners.map(p => [p.x / image.width, p.y / image.height] as Point),
      }));
    },
  };
}

/** Includes a white quiet margin so the downloaded marker can be printed as-is. */
export function createMarkerSvg(dictionary: MarkerDictionary = DEFAULT_MARKER_DICTIONARY, id = 0): string {
  return new AR.Dictionary(dictionary).generateSVG(id)
    .replace("<svg ", '<svg width="600" height="600" shape-rendering="crispEdges" ');
}

/** Independent overlay loop: no contact events and no changes to shared vision contracts. */
export function startMarkerDetection(
  video: HTMLVideoElement,
  options: { dictionary: MarkerDictionary; onMarkers: (markers: DetectedMarker[]) => void; onError: (error: unknown) => void },
): { stop(): void } {
  const detector = createMarkerDetector(options.dictionary);
  const sample = document.createElement("canvas");
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the marker detection canvas.");
  let stopped = false;
  let animation = 0;
  let lastTime = -1;
  let lastProcessed = -Infinity;
  const stop = () => { stopped = true; cancelAnimationFrame(animation); sample.width = 0; sample.height = 0; };
  const tick = (t: number) => {
    if (stopped) return;
    // Run at most 10 times/second, at up to 640 px wide, without queuing old frames.
    if (video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== lastTime && t - lastProcessed >= 100) {
      lastTime = video.currentTime; lastProcessed = t;
      const width = Math.min(640, video.videoWidth);
      const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
      if (sample.width !== width || sample.height !== height) { sample.width = width; sample.height = height; }
      try {
        context.drawImage(video, 0, 0, width, height);
        options.onMarkers(detector.detect(context.getImageData(0, 0, width, height)));
      } catch (error) { stop(); options.onError(error); return; }
    }
    animation = requestAnimationFrame(tick);
  };
  animation = requestAnimationFrame(tick);
  return { stop };
}

/** Draw the rotated marker outline and an upright ID even when the feed is mirrored. */
export function drawMarkerBoxes(
  ctx: CanvasRenderingContext2D, markers: DetectedMarker[], mirrored = false,
) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.strokeStyle = "#ffdc70"; ctx.lineWidth = 3;
  ctx.font = "bold 15px sans-serif";
  for (const marker of markers) {
    if (marker.corners.length !== 4) continue;
    ctx.beginPath();
    marker.corners.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x * width, y * height) : ctx.lineTo(x * width, y * height));
    ctx.closePath(); ctx.stroke();
    const regions = [
      { outline: outlines[marker.id], stroke: "#fc91ac", fill: "#fc91ac22" },
      { outline: handleOutlines[marker.id], stroke: "#84b8ff", fill: "#84b8ff22" },
    ];
    for (const region of regions) {
      if (!region.outline) continue;
      const points = projectOutline(marker, region.outline);

      if (points.length >= 3) {
        ctx.save();

        ctx.strokeStyle = region.stroke;
        ctx.fillStyle = region.fill;
        ctx.lineWidth = 3;

        ctx.beginPath();

        points.forEach(([x, y], index) => {
          if (index === 0) {
            ctx.moveTo(x * width, y * height);
          } else {
            ctx.lineTo(x * width, y * height);
          }
        });

        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    const first = marker.corners[0]!;
    ctx.fillStyle = "#ffdc70";
    ctx.fillRect(first[0] * width - 4, first[1] * height - 4, 8, 8);
    const text = `ArUco ${marker.id}`;
    const labelWidth = ctx.measureText(text).width + 12;
    const xs = marker.corners.map(([x]) => (mirrored ? 1 - x : x) * width);
    const x = Math.max(0, Math.min(width - labelWidth, Math.min(...xs)));
    const y = Math.max(0, Math.min(height - 26, Math.min(...marker.corners.map(([, y]) => y * height)) - 28));
    ctx.save();
    // Cancel the feed's CSS mirror for the label only. Geometry stays in raw coordinates.
    if (mirrored) { ctx.translate(width, 0); ctx.scale(-1, 1); }
    ctx.fillStyle = "#101613"; ctx.fillRect(x, y, labelWidth, 25);
    ctx.fillStyle = "#ffdc70"; ctx.fillText(text, x + 6, y + 18);
    ctx.restore();
  }
  ctx.restore();
}
