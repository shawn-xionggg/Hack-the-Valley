import { describe, expect, it } from "vitest";
import type { ContactTarget } from "../shared/config";
import { classifyAttempt, clusterAttempts, tallyTrial } from "./trials";
import type { VisionEvent } from "./trials";

let n = 0;
const contact = (b: ContactTarget, t: number, confidence = 1): VisionEvent =>
  ({ id: `c${++n}`, t, kind: "contact", a: "hands", b, confidence, source: "camera" });
const wash = (t: number): VisionEvent =>
  ({ id: `w${++n}`, t, kind: "wash", method: "zone-dwell", durationMs: 6000, source: "camera", verified: false });
const utensilWashed = (t: number): VisionEvent =>
  ({ id: `u${++n}`, t, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell", durationMs: 6000, source: "camera", verified: false });
/** A3: vision sends a utensil wash as a wash directly followed by utensil-washed, at the same t. */
const pair = (t: number) => [wash(t), utensilWashed(t)];

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

  it("counts a held touch's re-fires as one touch, not a double fire", () => {
    const held = [contact("tongs-handle", 400), contact("tongs-handle", 1400), contact("tongs-handle", 2400)];
    expect(classifyAttempt(held, "tongs-handle")).toBe("correct");
    expect(classifyAttempt([...held, contact("tongs-handle", 2900)], "tongs-handle")).toBe("fired-twice"); // re-entered
    expect(tallyTrial(held, "tongs-handle", 1).outcomes.correct).toBe(1);
  });

  it("counts missed attempts and expected-zone confidence", () => {
    const events = [
      contact("tongs-tip", 1000, 0.9),
      contact("tongs-tip", 4000, 0.7), contact("tongs-tip", 4500, 1), // double fire
      contact("tongs-handle", 8000), // mix-up: its confidence is not counted
    ];
    const tally = tallyTrial(events, "tongs-tip", 5);
    expect(tally.outcomes).toEqual({ correct: 1, "fired-twice": 1, "wrong-tong-part": 1, "wrong-wash": 0, unexpected: 0 });
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

  it("counts a wash + utensil-washed pair as one wash (W3: --expect utensil-washed)", () => {
    expect(classifyAttempt(pair(0), "utensil-washed")).toBe("correct");
    expect(classifyAttempt([utensilWashed(0), wash(0)], "utensil-washed")).toBe("correct"); // export order doesn't matter
    // The jaw ends reached the sink after the hands, so a hands-only wash fired first in the same visit (§4.4).
    expect(classifyAttempt([wash(0), ...pair(400)], "utensil-washed")).toBe("correct");
    expect(classifyAttempt([...pair(0), ...pair(800)], "utensil-washed")).toBe("fired-twice");
    expect(classifyAttempt([wash(0)], "utensil-washed")).toBe("wrong-wash"); // the tong dwell never completed
    expect(classifyAttempt([utensilWashed(0)], "utensil-washed")).toBe("unexpected"); // no wash first: invariant 7
    expect(classifyAttempt([wash(0), utensilWashed(300)], "utensil-washed")).toBe("wrong-wash"); // not the same dwell
    const tally = tallyTrial([...pair(1000), ...pair(10000), wash(20000)], "utensil-washed", 4);
    expect(tally.registered).toBe(3);
    expect(tally.outcomes).toMatchObject({ correct: 2, "wrong-wash": 1, unexpected: 0 });
    expect(tally.missed).toBe(1);
  });

  it("flags a utensil wash in a hands-only set (W5: --expect wash)", () => {
    expect(classifyAttempt(pair(0), "wash")).toBe("wrong-wash");
    expect(classifyAttempt([wash(0), ...pair(400)], "wash")).toBe("wrong-wash");
    expect(classifyAttempt([utensilWashed(0)], "wash")).toBe("unexpected");
    const tally = tallyTrial([wash(1000), ...pair(10000), wash(20000)], "wash", 3);
    expect(tally.registered).toBe(3); // the pair is one attempt, not two
    expect(tally.outcomes).toMatchObject({ correct: 2, "wrong-wash": 1, "fired-twice": 0, unexpected: 0 });
  });

  it("treats a pair as one false positive elsewhere (W4: --expect none)", () => {
    expect(classifyAttempt(pair(0), "none")).toBe("unexpected");
    expect(classifyAttempt([contact("meal-1", 0), ...pair(100)], "meal-1")).toBe("unexpected");
    expect(tallyTrial(pair(1000), "none", 5).outcomes.unexpected).toBe(1);
  });
});
