import { describe, expect, it } from "vitest";
import type { ContactTarget } from "../shared/config";
import type { ContactEvent } from "../shared/events";
import { createObjectRegistry } from "./registry";
import { applyContact } from "./transfer";

const contact = (id: string, b: ContactTarget, confidence = 1): ContactEvent => ({
  id, kind: "contact", a: "hands", b, confidence, source: "sim", t: 1000,
});

// Models state left by a future intervention handler, without implementing one here.
function clearHands(state: ReturnType<typeof createObjectRegistry>) {
  for (const record of state.records) {
    if (record.surfaceId === "hands" && record.clearedByEventId === null) record.clearedByEventId = "wash-fixture";
  }
  state.surfaces.hands = { id: "hands", status: "no-tracked-exposure", allergens: [], activeRecordIds: [] };
}

describe("contact propagation", () => {
  it("records source-to-hand transfers onward to tip and meal without changing inputs", () => {
    const initial = createObjectRegistry("test");
    const untouched = structuredClone(initial);
    const firstEvent = contact("e1", "peanut-source");
    let state = applyContact(initial, firstEvent);
    firstEvent.b = "meal-1";
    state = applyContact(state, contact("e2", "tongs-tip"));
    state = applyContact(state, contact("e3", "meal-1"));
    expect(initial).toEqual(untouched);
    expect(state.records.map(r => r.surfaceId)).toEqual(["peanut-source", "hands", "tongs-tip", "meal-1"]);
    expect(state.records[1]!.parentRecordId).toBe(state.records[0]!.id);
    expect(state.records[2]!.parentRecordId).toBe(state.records[1]!.id);
    expect(state.records[3]!.parentRecordId).toBe(state.records[1]!.id);
    expect(state.records[2]).toMatchObject({ fromSurfaceId: "hands", causedByEventId: "e2", t: 1000 });
    expect(state.surfaces["meal-1"].status).toBe("potential-exposure");
    expect(state.surfaces["tongs-handle"].allergens).toEqual([]);
    expect(state.log[0]!.event).toMatchObject({ b: "peanut-source" });
    expect(state.alerts).toEqual([]);
  });

  it.each(["tongs-tip", "tongs-handle"] as const)("transfers back from %s without exposing the other end", target => {
    let state = applyContact(createObjectRegistry("test"), contact("e1", "peanut-source"));
    state = applyContact(state, contact("e2", target));
    const originalHandRecord = state.records[1]!.id;
    clearHands(state);
    const other = target === "tongs-tip" ? "tongs-handle" : "tongs-tip";
    state = applyContact(state, contact("e3", other));
    expect(state.surfaces.hands.allergens).toEqual([]);
    state = applyContact(state, contact("e4", target));
    expect(state.surfaces.hands.allergens).toEqual(["peanut"]);
    expect(state.surfaces[other].allergens).toEqual([]);
    const reexposure = state.records.at(-1)!;
    expect(reexposure.parentRecordId).toBe(state.surfaces[target].activeRecordIds[0]);
    expect(reexposure.id).not.toBe(originalHandRecord);
    expect(state.records.find(r => r.id === originalHandRecord)!.clearedByEventId).toBe("wash-fixture");
  });

  it("deduplicates event IDs and repeated exposure without bouncing records", () => {
    const event = contact("e1", "peanut-source");
    let state = applyContact(createObjectRegistry("test"), event);
    state = applyContact(state, { ...event, b: "meal-1" });
    state = applyContact(state, contact("e2", "peanut-source"));
    expect(state.records).toHaveLength(2);
    expect(state.surfaces["meal-1"].allergens).toEqual([]);
    expect(state.log.map(e => e.effect)).toEqual(["applied", "ignored-duplicate-id", "no-change"]);
  });

  it("logs low confidence and reserves its ID; accepts the exact threshold", () => {
    let state = applyContact(createObjectRegistry("test"), contact("low", "peanut-source", 0.59));
    expect(state.records).toHaveLength(1);
    state = applyContact(state, contact("low", "peanut-source", 1));
    state = applyContact(state, contact("boundary", "peanut-source", 0.6));
    expect(state.log.map(e => e.effect)).toEqual(["ignored-low-confidence", "ignored-duplicate-id", "applied"]);
    expect(state.surfaces.hands.allergens).toEqual(["peanut"]);
    expect(applyContact(createObjectRegistry("custom"), contact("e", "peanut-source", 0.7), 0.8).records).toHaveLength(1);
  });

  it("does nothing on unexposed contact and replays deterministically", () => {
    const initial = createObjectRegistry("test");
    expect(applyContact(initial, contact("plain", "meal-1")).log[0]!.effect).toBe("no-change");
    const events = [contact("a", "peanut-source"), contact("b", "tongs-tip"), contact("c", "meal-1")];
    const replay = () => events.reduce((state, event) => applyContact(state, event), initial);
    expect(replay()).toEqual(replay());
  });
});

