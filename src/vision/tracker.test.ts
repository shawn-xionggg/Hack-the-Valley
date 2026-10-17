import { describe, expect, it } from "vitest";
import type { Point, Polygon, UtensilMarkerModel, UtensilModels, ZoneLayout } from "../shared/config";
import type { ContactEvent, WashEvent } from "../shared/events";
import type { DetectedMarker } from "./aruco";
import { TOOL_ZONE_MARGIN, createTracker, pointInPolygon } from "./tracker";

const square: [number, number][] = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
const zones = (): ZoneLayout => ({ "peanut-source": square, "tongs-tip": [], "tongs-handle": [], "meal-1": [], "wash-station": [] });
const hand = Array.from({ length: 21 }, () => ({ x: 0.2, y: 0.2, z: 0 }));

describe("vision event integration", () => {
  it("checks polygon containment in raw normalized coordinates", () => {
    expect(pointInPolygon([0.2, 0.2], square)).toBe(true);
    expect(pointInPolygon([0.8, 0.2], square)).toBe(false);
    expect(pointInPolygon([0.2, 0.2], [])).toBe(false);
  });

  it("emits once per dwell and rearms only after exit", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(zones(), event => events.push(event));
    for (let t = 0; t <= 1000; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "contact", a: "hands", b: "peanut-source", source: "camera", t: 400, confidence: 1 });
    tracker.update([], 1100, 10);
    tracker.update([], 1300, 10);
    for (let t = 1400; t <= 1800; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(2);
    expect(events[0]!.id).not.toBe(events[1]!.id);
  });

  it("re-fires every heldContactRefireMs while held, each with a fresh id", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(zones(), event => events.push(event));
    for (let t = 0; t <= 2500; t += 100) tracker.update([hand], t, 10);
    expect(events.map(e => e.t)).toEqual([400, 1400, 2400]);
    expect(new Set(events.map(e => e.id)).size).toBe(3);
  });

  it("scores each re-fire on the frames since the previous emission", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(zones(), event => events.push(event));
    for (let t = 0; t <= 400; t += 100) tracker.update([hand], t, 10);
    tracker.update([], 500, 10); // brief gaps under contactExitMs keep the dwell alive
    tracker.update([], 600, 10);
    for (let t = 700; t <= 1400; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ t: 400, confidence: 1 });
    expect(events[1]).toMatchObject({ t: 1400, confidence: 0.8 }); // 8 of the 10 frames 500–1400
  });

  it("reports fixed tong polygons and no tool contacts without a marker model", () => {
    const layout = { ...zones(), "tongs-tip": square };
    const status = createTracker(layout, () => {}).update([hand], 0, 10);
    expect(status.activeToolContacts).toEqual([]);
    expect(status.utensils.tongs).toEqual({ tracking: "fixed", lastSeenT: null,
      parts: { "tongs-tip": square, "tongs-handle": [] } });
  });

  it("does not count a camera stall as observed dwell", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(zones(), event => events.push(event));
    tracker.update([hand], 0, 10);
    tracker.update([hand], 2000, 10);
    expect(events).toHaveLength(0);
  });

  it("clears pending dwell when calibration changes", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(zones(), event => events.push(event));
    tracker.update([hand], 0, 10);
    tracker.update([hand], 300, 10);
    tracker.setZones(zones());
    tracker.update([hand], 400, 10);
    expect(events).toHaveLength(0);
  });

  it("resolves overlapping tong zones to a single contact", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker({ ...zones(), "peanut-source": [], "tongs-tip": square, "tongs-handle": square }, event => events.push(event));
    for (let t = 0; t <= 500; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "contact", b: "tongs-tip" });
  });

  it("requires sustained wash dwell and an exit before another wash", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker({ ...zones(), "peanut-source": [], "wash-station": square }, event => events.push(event));
    for (let t = 0; t <= 7000; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "wash", t: 6000, durationMs: 6000, verified: false, source: "camera" });
    tracker.update([], 7100, 10);
    tracker.update([], 7500, 10);
    expect(tracker.update([], 7600, 10).washProgress).toBe(0);
    for (let t = 7700; t <= 13700; t += 100) tracker.update([hand], t, 10);
    expect(events).toHaveLength(2);
  });

  it("tolerates a brief wash gap and resets after a longer gap", () => {
    const tracker = createTracker({ ...zones(), "wash-station": square }, () => {});
    tracker.update([hand], 0, 10);
    tracker.update([hand], 300, 10);
    tracker.update([], 500, 10);
    expect(tracker.update([hand], 600, 10).washProgress).toBeCloseTo(0.1);
    tracker.update([], 900, 10);
    expect(tracker.update([], 1100, 10).washProgress).toBe(0);
  });
});

// Moving tongs (spec A1 §4.4). A 0.05-high tag at the centre of a square frame; the jaw end is
// 4 tag widths to its left, the tip polygon covers x 0.30–0.45 and the handle x 0.55–0.90.
const SIDE = 0.05;
function tag(id: number, cx = 0.5, cy = 0.5, side = SIDE, aspect = 1): DetectedMarker {
  return { id, corners: ([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as Point[])
    .map(([x, y]) => [cx + x * side / aspect, cy + y * side] as Point) };
}
const tongModel = (markerId = 11, jaw: Point = [-4, 0]): UtensilMarkerModel => ({
  markerId,
  parts: { "tongs-tip": [[-4, -0.6], [-1, -0.6], [-1, 0.6], [-4, 0.6]], "tongs-handle": [[1, -0.6], [8, -0.6], [8, 0.6], [1, 0.6]] },
  tipContactPoints: [jaw],
});
const models = (...entries: UtensilMarkerModel[]): UtensilModels => ({ tongs: { markers: entries.length ? entries : [tongModel()] } });
const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const handAt = (x: number, y: number) => Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
/** Peanuts under the jaw end; the meal far from the tongs; static tong zones somewhere else entirely. */
const table = (): ZoneLayout => ({ "peanut-source": box(0.25, 0.45, 0.35, 0.55), "meal-1": box(0.7, 0.8, 0.9, 0.95),
  "tongs-tip": box(0.05, 0.05, 0.1, 0.1), "tongs-handle": box(0.12, 0.05, 0.2, 0.1), "wash-station": [] });
const seen = (...markers: DetectedMarker[]) => ({ markers, aspect: 1 });

describe("moving tongs", () => {
  it("projects the parts from the visible marker and reports tracked", () => {
    const status = createTracker(table(), () => {}, {}, models()).update([], 0, 10, seen(tag(11)));
    expect(status.utensils.tongs.tracking).toBe("tracked");
    expect(status.utensils.tongs.lastSeenT).toBe(0);
    const tip = status.utensils.tongs.parts!["tongs-tip"];
    expect(tip[0]![0]).toBeCloseTo(0.3);
    expect(tip[1]![0]).toBeCloseTo(0.45);
  });

  it("is lost, not tracked, before any calibrated marker has been seen", () => {
    const tracker = createTracker(table(), () => {}, {}, models());
    expect(tracker.update([], 0, 10, seen(tag(12))).utensils.tongs).toEqual({ tracking: "lost", parts: null, lastSeenT: null });
  });

  it("holds the last pose for utensilHoldMs, then reports lost with no parts", () => {
    const tracker = createTracker(table(), () => {}, {}, models());
    const first = tracker.update([], 0, 10, seen(tag(11)));
    const held = tracker.update([], 500, 10, seen());
    expect(held.utensils.tongs.tracking).toBe("held");
    expect(held.utensils.tongs.parts).toEqual(first.utensils.tongs.parts);
    expect(tracker.update([], 600, 10, seen()).utensils.tongs).toEqual({ tracking: "lost", parts: null, lastSeenT: 0 });
    expect(tracker.update([], 700, 10, seen(tag(11))).utensils.tongs.tracking).toBe("tracked");
  });

  it("fires tool contacts from the jaw end, with dwell and held re-fire", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(table(), event => events.push(event), {}, models());
    let status;
    for (let t = 0; t <= 1500; t += 100) status = tracker.update([], t, 10, seen(tag(11)));
    expect(status!.activeToolContacts).toEqual([{ a: "tongs-tip", b: "peanut-source" }]);
    expect(events.map(e => e.t)).toEqual([400, 1400]);
    expect(events[0]).toMatchObject({ kind: "contact", a: "tongs-tip", b: "peanut-source", confidence: 1, source: "camera" });
  });

  it("counts only tracked frames toward confidence, and stops at lost", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(table(), event => events.push(event), {}, models());
    tracker.update([], 0, 10, seen(tag(11)));
    tracker.update([], 100, 10, seen(tag(11)));
    for (let t = 200; t <= 400; t += 100) tracker.update([], t, 10, seen()); // marker buried in the dip: held
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 400, a: "tongs-tip", confidence: 1 }); // 2 of 2 tracked frames
    for (let t = 500; t <= 2000; t += 100) tracker.update([], t, 10, seen()); // lost from 700
    expect(events).toHaveLength(1);
  });

  it("grows targets by TOOL_ZONE_MARGIN marker sides, measured square on a 16:9 frame", () => {
    const aspect = 16 / 9;
    const jawX = 0.5 - 4 * SIDE / aspect; // normalized x of the jaw end
    const fires = (gap: number) => {
      const events: (ContactEvent | WashEvent)[] = [];
      // Peanut zone starts `gap` frame-heights to the left of the jaw end.
      const left = jawX - gap / aspect;
      const tracker = createTracker({ ...table(), "peanut-source": box(left - 0.1, 0.45, left, 0.55) }, event => events.push(event), {}, models());
      for (let t = 0; t <= 400; t += 100) tracker.update([], t, 10, { markers: [tag(11, 0.5, 0.5, SIDE, aspect)], aspect });
      return events.length > 0;
    };
    expect(fires(TOOL_ZONE_MARGIN * SIDE * 0.9)).toBe(true);
    expect(fires(TOOL_ZONE_MARGIN * SIDE * 1.1)).toBe(false);
  });

  it("never emits a handle tool contact, even with the handle over the meal (A2)", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker({ ...table(), "peanut-source": [], "meal-1": box(0.8, 0.4, 0.95, 0.6) }, event => events.push(event), {}, models());
    let status;
    for (let t = 0; t <= 1500; t += 100) status = tracker.update([], t, 10, seen(tag(11)));
    expect(status!.activeToolContacts).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a scoop with the handle over the bowl exposes only the tips (A2)", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    // The bowl spans the jaw end (x 0.3) and the start of the handle (x 0.55–0.6).
    const tracker = createTracker({ ...table(), "peanut-source": box(0.25, 0.4, 0.6, 0.6) }, event => events.push(event), {}, models());
    let status;
    for (let t = 0; t <= 1500; t += 100) status = tracker.update([], t, 10, seen(tag(11)));
    expect(status!.activeToolContacts).toEqual([{ a: "tongs-tip", b: "peanut-source" }]);
    expect(events.map(e => e.kind === "contact" && e.a)).toEqual(["tongs-tip", "tongs-tip"]);
  });

  it("tests fingertips against the moving parts, not the static tong zones", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker({ ...table(), "peanut-source": [] }, event => events.push(event), {}, models());
    for (let t = 0; t <= 400; t += 100) tracker.update([handAt(0.4, 0.5), handAt(0.07, 0.07)], t, 10, seen(tag(11)));
    expect(events.filter(e => e.kind === "contact" && e.a === "hands").map(e => e.kind === "contact" && e.b)).toEqual(["tongs-tip"]);
  });

  it("records no contact of any kind with the tongs while lost", () => {
    const events: (ContactEvent | WashEvent)[] = [];
    const tracker = createTracker(table(), event => events.push(event), {}, models());
    tracker.update([], 0, 10, seen(tag(11)));
    for (let t = 100; t <= 600; t += 100) tracker.update([], t, 10, seen());
    events.length = 0; // the held jaw end was still in the peanuts
    for (let t = 700; t <= 1500; t += 100) {
      const status = tracker.update([handAt(0.4, 0.5)], t, 10, seen());
      expect(status.activeZones).toEqual([]);
      expect(status.activeToolContacts).toEqual([]);
    }
    expect(events).toEqual([]);
  });

  it("places the tongs from the larger face when both show", () => {
    const tracker = createTracker(table(), () => {}, {}, models(tongModel(11), tongModel(12, [-3, 0])));
    tracker.update([], 0, 10, seen(tag(11, 0.5, 0.5, 0.04), tag(12, 0.5, 0.5, 0.05)));
    expect(tracker.jawPoints()![0]![0]).toBeCloseTo(0.5 - 3 * 0.05);
  });

  it("falls back to fixed polygons when the models are cleared", () => {
    const tracker = createTracker(table(), () => {}, {}, models());
    tracker.update([], 0, 10, seen(tag(11)));
    tracker.setUtensilModels({});
    const status = tracker.update([], 100, 10, seen(tag(11)));
    expect(status.utensils.tongs).toEqual({ tracking: "fixed", lastSeenT: null,
      parts: { "tongs-tip": table()["tongs-tip"], "tongs-handle": table()["tongs-handle"] } });
    expect(status.activeToolContacts).toEqual([]);
  });
});

