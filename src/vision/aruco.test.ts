import { describe, expect, it } from "vitest";
import { AR } from "js-aruco2";
import {
  createMarkerDetector, createMarkerSvg, createMarkerTrial, createTongMarkerSheet, markerSidePx, recordMarkerFrame,
} from "./aruco";
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

  it("orders corners by the tag's own orientation, so marker-local axes turn with the tongs", () => {
    const upright = frame(), turned = frame();
    stamp(upright, "ARUCO_4X4_50", 11, 100, 100);
    stamp(turned, "ARUCO_4X4_50", 11, 100, 100, true); // turned 90° clockwise
    const [a] = createMarkerDetector().detect(upright);
    const [b] = createMarkerDetector().detect(turned);
    // Corner 0 is the tag's top-left: top-left of the box upright, top-right once turned clockwise.
    expect(a!.corners[0]![0]).toBeCloseTo(100 / 640, 2);
    expect(a!.corners[0]![1]).toBeCloseTo(100 / 480, 2);
    expect(b!.corners[0]![0]).toBeCloseTo(208 / 640, 2);
    expect(b!.corners[0]![1]).toBeCloseTo(100 / 480, 2);
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

describe("tong marker go/no-go helpers", () => {
  it("measures marker side length in pixels of the detection frame", () => {
    const image = frame();
    stamp(image, "ARUCO_4X4_50", 11, 100, 100); // 6 modules × 18 px
    const [marker] = createMarkerDetector().detect(image);
    expect(markerSidePx(marker!, image.width, image.height)).toBeGreaterThan(104);
    expect(markerSidePx(marker!, image.width, image.height)).toBeLessThan(110);
    // The same normalized corners are half as many pixels in a half-size frame.
    expect(markerSidePx(marker!, image.width / 2, image.height / 2)).toBeLessThan(55);
  });

  it("counts frames with either tong marker, ignoring other IDs", () => {
    const trial = createMarkerTrial();
    const square = (id: number, side: number) => ({ id, corners: [[0, 0], [side, 0], [side, side], [0, side]] as [number, number][] });
    recordMarkerFrame(trial, [square(11, 0.05)], { width: 1000, height: 1000 });
    recordMarkerFrame(trial, [square(0, 0.05)], { width: 1000, height: 1000 });
    recordMarkerFrame(trial, [], { width: 1000, height: 1000 });
    recordMarkerFrame(trial, [square(11, 0.04), square(12, 0.03)], { width: 1000, height: 1000 });
    expect(trial).toEqual({ frames: 4, detected: 2, framesById: { 11: 2, 12: 1 }, minSidePx: 30 });
  });

  it("prints IDs 11 and 12 at physical size, margin included", () => {
    const sheet = createTongMarkerSheet();
    for (const id of [11, 12]) {
      const svg = new AR.Dictionary("ARUCO_4X4_50").generateSVG(id);
      expect(sheet).toContain(svg.slice(svg.indexOf("<rect"))); // exact dictionary bits
    }
    // 25 mm and 30 mm black squares are 6 of 8 modules: 33.33 mm and 40 mm with the white margin.
    expect(sheet.match(/width="33\.33mm"/g)).toHaveLength(2);
    expect(sheet.match(/width="40\.00mm"/g)).toHaveLength(2);
    expect(sheet).toContain('width="50mm"');
  });
});
