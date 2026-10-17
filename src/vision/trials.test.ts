import { describe, expect, it } from "vitest";
import type { ContactTarget } from "../shared/config";
import { classifyAttempt, clusterAttempts, tallyTrial } from "./trials";
import type { VisionEvent } from "./trials";

let n = 0;
const contact = (b: ContactTarget, t: number, confidence = 1): VisionEvent =>
  ({ id: `c${++n}`, t, kind: "contact", a: "hands", b, confidence, source: "camera" });
const wash = (t: number): VisionEvent =>
  ({ id: `w${++n}`, t, kind: "wash", method: "zone-dwell", durationMs: 6000, source: "camera", verified: false });

describe("rig trial tally", () => {
  it("splits attempts on quiet gaps, regardless of input order", () => {
    const events = [contact("tongs-tip", 5000), contact("tongs-tip", 1000), contact("tongs-tip", 1800)];
    expect(clusterAttempts(events, 1500).map(cluster => cluster.map(e => e.t))).toEqual([[1000, 1800], [5000]]);
    expect(clusterAttempts([])).toEqual([]);
  });

  it("ranks a tip/handle mix-up above a stray zone above a double fire", () => {
    expect(classifyAttempt([contact("tongs-tip", 0)], "tongs-tip")).toBe("correct");
    expect(classifyAttempt([contact("tongs-tip", 0), contact("tongs-tip", 800)], "tongs-tip")).toBe("fired-twice");
    expect(classifyAttempt([contact("tongs-tip", 0), contact("meal-1", 100)], "tongs-tip")).toBe("unexpected");
    expect(classifyAttempt([contact("tongs-handle", 0), contact("meal-1", 100)], "tongs-tip")).toBe("wrong-tong-part");
    expect(classifyAttempt([contact("tongs-tip", 0)], "meal-1")).toBe("unexpected"); // only tong parts can be mixed up
    expect(classifyAttempt([wash(0)], "wash")).toBe("correct");
    expect(classifyAttempt([wash(0)], "none")).toBe("unexpected");
  });

  it("counts missed attempts and expected-zone confidence", () => {
    const events = [
      contact("tongs-tip", 1000, 0.9),
      contact("tongs-tip", 4000, 0.7), contact("tongs-tip", 4500, 1), // double fire
      contact("tongs-handle", 8000), // mix-up: its confidence is not counted
    ];
    const tally = tallyTrial(events, "tongs-tip", 5);
    expect(tally.outcomes).toEqual({ correct: 1, "fired-twice": 1, "wrong-tong-part": 1, unexpected: 0 });
    expect(tally.registered).toBe(3);
    expect(tally.missed).toBe(2);
    expect(tally.confidence?.min).toBeCloseTo(0.7);
    expect(tally.confidence?.mean).toBeCloseTo(0.8667, 3);
  });

  it("treats every event as a false positive when nothing was expected", () => {
    const tally = tallyTrial([wash(1000), contact("meal-1", 9000)], "none", 5);
    expect(tally.outcomes.unexpected).toBe(2);
    expect(tally.missed).toBeNull();
    expect(tallyTrial([], "none", 5).registered).toBe(0);
  });
});
