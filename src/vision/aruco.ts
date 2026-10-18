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

/** The pixel frame a detection ran on, and how long it took. */
export interface MarkerFrame { width: number; height: number; ms: number }

/** Spec A1 §4.4: ID 11 on arm A's outer face, ID 12 on arm B's, both just behind the jaws. */
export const TONG_MARKER_IDS: readonly number[] = [11, 12];
const TONG_ARMS: Record<number, string> = { 11: "arm A", 12: "arm B" };
/** Smallest marker side the §4.4 error budget allows. */
export const MIN_MARKER_SIDE_PX = 30;
/** §4.6 night-one go/no-go: at least this fraction of trial frames must show a tong marker. */
export const GO_NO_GO_RATE = 0.8;

/** Shortest side of the marker, in pixels of the frame it was detected in. */
export function markerSidePx(marker: DetectedMarker, width: number, height: number): number {
  return Math.min(...marker.corners.map(([x, y], i) => {
    const [nx, ny] = marker.corners[(i + 1) % marker.corners.length]!;
    return Math.hypot((nx - x) * width, (ny - y) * height);
  }));
}

/** One §4.6 go/no-go trial: sampled frames, and how many showed at least one tong marker. */
export interface MarkerTrial { frames: number; detected: number; framesById: Record<number, number>; minSidePx: number | null }

export function createMarkerTrial(): MarkerTrial {
  return { frames: 0, detected: 0, framesById: {}, minSidePx: null };
}

/** Other IDs in view (test markers) don't count toward the trial. */
export function recordMarkerFrame(trial: MarkerTrial, markers: DetectedMarker[], frame: { width: number; height: number }) {
  const tong = markers.filter(marker => TONG_MARKER_IDS.includes(marker.id));
  trial.frames++;
  if (!tong.length) return;
  trial.detected++;
  for (const marker of tong) {
    trial.framesById[marker.id] = (trial.framesById[marker.id] ?? 0) + 1;
    const side = markerSidePx(marker, frame.width, frame.height);
    trial.minSidePx = Math.min(trial.minSidePx ?? side, side);
  }
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

/** js-aruco2's SVG is one module of white margin around the black square (code plus 1-bit border). */
function markerSvg(dictionary: MarkerDictionary, id: number, size: string): string {
  return new AR.Dictionary(dictionary).generateSVG(id)
    .replace("<svg ", `<svg width="${size}" height="${size}" shape-rendering="crispEdges" `);
}

/** Includes a white quiet margin so the downloaded marker can be printed as-is. */
export function createMarkerSvg(dictionary: MarkerDictionary = DEFAULT_MARKER_DICTIONARY, id = 0): string {
  return markerSvg(dictionary, id, "600");
}

/**
 * Printable HTML sheet of the tong markers at physical size (§4.4: 25 mm black square, 30 mm as the
 * fallback). Everything is drawn in SVG, so it prints without "Background graphics" enabled.
 */
export function createTongMarkerSheet(blackSquareMm: readonly number[] = [25, 30]): string {
  const dictionary: MarkerDictionary = "ARUCO_4X4_50";
  const rows = blackSquareMm.map(size => {
    // 4×4 code + 1-module border = 6 modules of black, plus a 1-module white margin on each side.
    const outer = (size * 8 / 6).toFixed(2);
    return `<div class="row">${TONG_MARKER_IDS.map(id => `<figure><div class="cut">${markerSvg(dictionary, id, `${outer}mm`)}</div>
      <figcaption><b>ID ${id}</b> · ${TONG_ARMS[id]} outer face<br>${size} mm black square</figcaption></figure>`).join("")}</div>`;
  }).join("");
  const ticks = [0, 10, 20, 30, 40, 50].map(x => `<rect x="${x === 50 ? 49.7 : x}" y="0" width="0.3" height="4" fill="black"/>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Allos tong markers</title><style>
  @page { margin: 12mm; }
  body { margin: 0; background: #fff; color: #000; font: 10pt/1.45 system-ui, sans-serif; }
  h1 { font-size: 13pt; margin: 0 0 2mm; }
  ol { margin: 0 0 6mm; padding-left: 5mm; }
  .row { display: flex; gap: 14mm; margin-bottom: 8mm; }
  figure { margin: 0; }
  figure svg { display: block; }
  .cut { outline: 0.2mm dashed #999; width: max-content; }
  figcaption { margin-top: 2mm; font-size: 9pt; }
  .scale { display: flex; align-items: center; gap: 4mm; margin-bottom: 6mm; }
  .scale svg { display: block; }
</style></head><body>
<h1>Allos tong markers · OpenCV DICT_4X4_50</h1>
<ol>
  <li>Print at <b>100% scale</b> ("Actual size", not "Fit to page"), on matte paper.</li>
  <li>Measure the bar below. If it isn't exactly 50 mm, fix the print scale and reprint.</li>
  <li>Cut along the dashed line, keeping the whole white margin. Cover with matte tape.</li>
  <li>Mount ID 11 on arm A's outer face and ID 12 on arm B's, flat, just behind the jaws, one edge parallel to the arm, above the food line.</li>
  <li>Use the 25 mm pair first, and switch to 30 mm if detection is unreliable. Keep the rest of this sheet out of the camera's view: only one copy of each ID may be visible.</li>
</ol>
<div class="scale"><svg width="50mm" height="4mm" viewBox="0 0 50 4" shape-rendering="crispEdges"><rect x="0" y="1.5" width="50" height="1" fill="black"/>${ticks}</svg><span>50 mm</span></div>
${rows}
<script>addEventListener("load", () => print());</script>
</body></html>`;
}

/**
 * Detects markers on the video's current frame at its native resolution. Downscaling the 720p feed
 * would halve tag size (§4.4 needs ≥ 30 px) and double pose error.
 */
export function createVideoMarkerDetector(dictionary: MarkerDictionary = DEFAULT_MARKER_DICTIONARY) {
  const detector = createMarkerDetector(dictionary);
  const sample = document.createElement("canvas");
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create the marker detection canvas.");
  return {
    detect(video: HTMLVideoElement): { markers: DetectedMarker[]; frame: MarkerFrame } {
      const begin = performance.now();
      const width = video.videoWidth, height = video.videoHeight;
      if (sample.width !== width || sample.height !== height) { sample.width = width; sample.height = height; }
      context.drawImage(video, 0, 0, width, height);
      const markers = detector.detect(context.getImageData(0, 0, width, height));
      return { markers, frame: { width, height, ms: performance.now() - begin } };
    },
    close() { sample.width = 0; sample.height = 0; },
  };
}

/** Draw each tag's outline, its corner 0, and an upright ID even when the feed is mirrored. */
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
