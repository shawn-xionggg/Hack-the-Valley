import { describe, expect, it } from "vitest";
import type { ContactPair, ContactEvent } from "../shared/events";
import { createObjectRegistry } from "./registry";
import { applyContact } from "./transfer";
import { buildExposureChain } from "./history";

const touch = (id: string, pair: ContactPair, confidence = 1): ContactEvent => ({
  ...pair, id, t: 1000, kind: "contact", source: "sim", confidence,
});
const seed = () => applyContact(createObjectRegistry("tools"), touch("seed", { a: "tongs-tip", b: "peanut-source" }));

describe("tool contacts", () => {
  it("explains peanut source to tips to meal without exposing hands or handle", () => {
    const state = applyContact(seed(), touch("serve", { a: "tongs-tip", b: "meal-1" }));
    expect(state.surfaces.hands.allergens).toEqual([]);
    expect(state.surfaces["tongs-handle"].allergens).toEqual([]);
    expect(state.surfaces["meal-1"].allergens).toEqual(["peanut"]);
    const result = buildExposureChain(state, state.surfaces["meal-1"].activeRecordIds[0]!);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.chain).toEqual([
      { kind: "origin", surfaceId: "peanut-source", allergen: "peanut", recordId: state.records[0]!.id },
      { kind: "transfer", from: "peanut-source", to: "tongs-tip", allergen: "peanut", eventId: "seed", recordId: state.records[1]!.id, t: 1000 },
      { kind: "transfer", from: "tongs-tip", to: "meal-1", allergen: "peanut", eventId: "serve", recordId: state.records[2]!.id, t: 1000 },
    ]);
  });

  it("transfers back from an exposed meal to an unexposed handle", () => {
    let state = applyContact(seed(), touch("serve", { a: "tongs-tip", b: "meal-1" }));
    state = applyContact(state, touch("handle", { a: "tongs-handle", b: "meal-1" }));
    expect(state.records.at(-1)).toMatchObject({ surfaceId: "tongs-handle", fromSurfaceId: "meal-1", parentRecordId: state.records[2]!.id });
    expect(state.surfaces.hands.allergens).toEqual([]);
  });

  it("a fresh held-grip event transfers exposure that arrived after the first grip", () => {
    const grip = { a: "hands", b: "tongs-handle" } as const;
    let state = applyContact(createObjectRegistry("held"), touch("grip1", grip));
    state = applyContact(state, touch("dip", { a: "tongs-handle", b: "peanut-source" }));
    state = applyContact(state, touch("grip2", grip));
    const count = state.records.length;
    expect(state.surfaces.hands.allergens).toEqual(["peanut"]);
    expect(state.surfaces["tongs-tip"].allergens).toEqual([]);
    state = applyContact(state, touch("grip3", grip));
    expect(state.records).toHaveLength(count);
    expect(state.log.at(-1)!.effect).toBe("no-change");
  });

  it.each([
    ["tongs-tip", "tongs-handle"], ["tongs-handle", "tongs-tip"],
    ["tongs-tip", "tongs-tip"], ["tongs-handle", "tongs-handle"],
    ["hands", "hands"], ["hands", "wash-station"], ["tongs-tip", "hands"],
    ["peanut-source", "meal-1"], ["unknown", "meal-1"], ["hands", "unknown"],
    [11, "meal-1"], [12, "meal-1"], [null, "meal-1"],
  ])("rejects unsupported pair %s -> %s without changing exposure", (a, b) => {
    const before = seed();
    const event = { kind: "contact", id: "invalid", t: 2000, a, b, confidence: 0, source: "sim" } as unknown as ContactEvent;
    const after = applyContact(before, event);
    expect(after.records).toEqual(before.records);
    expect(after.surfaces).toEqual(before.surfaces);
    expect(after.log.at(-1)!.effect).toBe("ignored-invalid-contact");
    expect(applyContact(after, event).log.at(-1)!.effect).toBe("ignored-duplicate-id");
  });

  it("filters low-confidence tool contacts and accepts the exact threshold", () => {
    const pair = { a: "tongs-tip", b: "peanut-source" } as const;
    let state = applyContact(createObjectRegistry("threshold"), touch("low", pair, 0.59));
    expect(state.records).toHaveLength(1);
    expect(state.log.at(-1)!.effect).toBe("ignored-low-confidence");
    state = applyContact(state, touch("boundary", pair, 0.6));
    expect(state.surfaces["tongs-tip"].allergens).toEqual(["peanut"]);
  });

  it("retains logical state across successive tool events without marker identity", () => {
    // CV may switch marker 11 -> 12 between these events. No marker field belongs in ContactPair.
    const first = seed();
    const again = applyContact(first, touch("fresh", { a: "tongs-tip", b: "peanut-source" }));
    expect(again.records).toEqual(first.records);
    expect(again.surfaces).toEqual(first.surfaces);
    const served = applyContact(again, touch("serve", { a: "tongs-tip", b: "meal-1" }));
    expect(served.records.at(-1)!.parentRecordId).toBe(first.records[1]!.id);
  });
});
