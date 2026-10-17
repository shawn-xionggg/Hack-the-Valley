import { describe, expect, it } from "vitest";
import { SURFACES } from "../shared/config";
import { createObjectRegistry } from "./registry";

describe("object registry", () => {
  it("initializes exactly the five exposure surfaces and one peanut origin", () => {
    const state = createObjectRegistry("test");
    expect(Object.keys(state.surfaces)).toEqual([
      "hands", "peanut-source", "tongs-tip", "tongs-handle", "meal-1",
    ]);
    expect(state.records).toEqual([{
      id: "origin:test:peanut-source:peanut", surfaceId: "peanut-source",
      allergen: "peanut", kind: "origin", causedByEventId: null,
      fromSurfaceId: null, parentRecordId: null, t: 0, clearedByEventId: null,
    }]);
    expect(state.surfaces["peanut-source"]).toEqual({
      id: "peanut-source", status: "potential-exposure", allergens: ["peanut"],
      activeRecordIds: [state.records[0]!.id],
    });
    for (const id of ["hands", "tongs-tip", "tongs-handle", "meal-1"] as const) {
      expect(state.surfaces[id]).toEqual({
        id, status: "no-tracked-exposure", allergens: [], activeRecordIds: [],
      });
    }
    expect(state.alerts).toEqual([]);
    expect(state.log).toEqual([]);
    expect(state.lastWash).toBeNull();
  });

  it("isolates surfaces, sessions, and shared configuration from mutations", () => {
    const first = createObjectRegistry("first");
    const second = createObjectRegistry("second");
    first.surfaces["tongs-tip"].allergens.push("peanut");
    first.surfaces["peanut-source"].allergens.length = 0;
    first.records[0]!.clearedByEventId = "example";
    expect(first.surfaces["tongs-handle"].allergens).toEqual([]);
    expect(second.surfaces["tongs-tip"].allergens).toEqual([]);
    expect(second.surfaces["peanut-source"].allergens).toEqual(["peanut"]);
    expect(second.records[0]!.clearedByEventId).toBeNull();
    expect(SURFACES["peanut-source"].initialAllergens).toEqual(["peanut"]);
  });

  it("produces deterministic initial state for the same session", () => {
    expect(createObjectRegistry("replay")).toEqual(createObjectRegistry("replay"));
  });

  it("rejects missing session identity", () => {
    expect(() => createObjectRegistry(" ")).toThrow("session ID");
  });
});
