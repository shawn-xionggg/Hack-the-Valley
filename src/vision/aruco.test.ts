import { describe, expect, it } from "vitest";
import { AR } from "js-aruco2";
import { createMarkerDetector, createMarkerSvg } from "./aruco";
import type { MarkerDictionary } from "./aruco";

function frame() {
  return { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4).fill(255) };
}

// Render real dictionary bits into RGBA pixels to exercise the actual detector.
function stamp(image: ReturnType<typeof frame>, dictionary: MarkerDictionary, id: number, x: number, y: number, rotated = false) {
  const bits = new AR.Dictionary(dictionary).codeList[id]!;
  const inner = Math.sqrt(bits.length), size = inner + 2, cell = 18;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const white = row > 0 && row <= inner && col > 0 && col <= inner && bits[(row - 1) * inner + col - 1] === "1";
    const dx = rotated ? size - 1 - row : col;
    const dy = rotated ? col : row;
    for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) {
      const offset = ((y + dy * cell + py) * image.width + x + dx * cell + px) * 4;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = white ? 255 : 0;
    }
  }
}

describe("ArUco marker detection", () => {
  for (const dictionary of ["ARUCO_4X4_50", "ARUCO_MIP_36h12", "ARUCO"] as const) {
    it(`detects an actual ${dictionary} marker with normalized corners`, () => {
      const image = frame();
      stamp(image, dictionary, 7, 100, 100);
      const markers = createMarkerDetector(dictionary).detect(image);
      expect(markers.map(m => m.id)).toEqual([7]);
      expect(markers[0]!.corners).toHaveLength(4);
      expect(Math.min(...markers[0]!.corners.map(([x]) => x))).toBeCloseTo(100 / 640, 2);
      expect(Math.min(...markers[0]!.corners.map(([, y]) => y))).toBeCloseTo(100 / 480, 2);
    });
  }

  it("recognizes a rotated marker and multiple distinct IDs in one frame", () => {
    const image = frame();
    stamp(image, "ARUCO_4X4_50", 3, 60, 80, true);
    stamp(image, "ARUCO_4X4_50", 12, 330, 220);
    const markers = createMarkerDetector().detect(image);
    expect(markers.map(m => m.id).sort((a, b) => a - b)).toEqual([3, 12]);
  });

  it("returns no stale boxes after a marker disappears", () => {
    const image = frame();
    stamp(image, "ARUCO_4X4_50", 0, 100, 100);
    const detector = createMarkerDetector();
    expect(detector.detect(image)).toHaveLength(1);
    expect(detector.detect(frame())).toEqual([]);
  });

  it("exports a printable SVG with a quiet margin and validates its ID", () => {
    expect(createMarkerSvg()).toContain('width="600" height="600"');
    expect(createMarkerSvg()).toContain('fill="white"');
    expect(() => createMarkerSvg("ARUCO_4X4_50", 50)).toThrow();
  });
});
