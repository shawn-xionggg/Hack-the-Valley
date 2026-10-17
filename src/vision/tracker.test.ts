import { describe, expect, it } from "vitest";
import type { ZoneLayout } from "../shared/config";
import type { ContactEvent, WashEvent } from "../shared/events";
import { createTracker, pointInPolygon } from "./tracker";

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

  it("reports fixed tong polygons and no tool contacts until marker tracking exists", () => {
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
