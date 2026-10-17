import { describe, expect, it } from "vitest";
import type { ContactTarget } from "../shared/config";
import { createObjectRegistry } from "./registry";
import { applyContact } from "./transfer";
import { buildExposureChain } from "./history";

function scenario(target: ContactTarget = "tongs-tip") {
  let state = createObjectRegistry("history");
  for (const [index, b] of (["peanut-source", target] as const).entries()) {
    state = applyContact(state, { kind: "contact", a: "hands", b, id: `e${index}`, t: 1000, confidence: 1, source: "sim" });
  }
  return state;
}

describe("exposure chain", () => {
  it("returns an origin-only chain", () => {
    const state = createObjectRegistry("test");
    const record = state.records[0]!;
    expect(buildExposureChain(state, record.id)).toEqual({ ok: true, chain: [
      { kind: "origin", surfaceId: "peanut-source", allergen: "peanut", recordId: record.id },
    ] });
  });

  it.each(["tongs-tip", "tongs-handle", "meal-1"] as const)("explains the actual path to %s with event evidence", target => {
    const state = scenario(target);
    const before = structuredClone(state);
    const result = buildExposureChain(state, state.records[2]!.id);
    expect(result).toEqual({ ok: true, chain: [
      { kind: "origin", surfaceId: "peanut-source", allergen: "peanut", recordId: state.records[0]!.id },
      { kind: "transfer", from: "peanut-source", to: "hands", allergen: "peanut", eventId: "e0", recordId: state.records[1]!.id, t: 1000 },
      { kind: "transfer", from: "hands", to: target, allergen: "peanut", eventId: "e1", recordId: state.records[2]!.id, t: 1000 },
    ] });
    expect(state).toEqual(before);
    expect(buildExposureChain(state, state.records[2]!.id)).toEqual(result);
  });

  it("retains cleared ancestors and excludes unrelated branches and duplicate deliveries", () => {
    let state = scenario();
    const targetId = state.records[2]!.id;
    const expected = buildExposureChain(state, targetId);
    state.records[1]!.clearedByEventId = "intervention-fixture";
    const event = { kind: "contact", a: "hands", b: "tongs-handle", id: "other", t: 2000, confidence: 1, source: "sim" } as const;
    state = applyContact(state, event);
    state = applyContact(state, event);
    state = applyContact(state, { ...event, id: "e1" });
    expect(buildExposureChain(state, targetId)).toEqual(expected);
  });

  it("reports unknown targets and missing parents without partial chains", () => {
    const state = scenario();
    expect(buildExposureChain(state, "absent")).toEqual({ ok: false, error: "missing-record", recordId: "absent" });
    state.records[2]!.parentRecordId = "absent";
    expect(buildExposureChain(state, state.records[2]!.id)).toEqual({ ok: false, error: "missing-record", recordId: "absent" });
  });

  it("detects cycles without looping", () => {
    const state = scenario();
    state.records[1]!.parentRecordId = state.records[2]!.id;
    expect(buildExposureChain(state, state.records[2]!.id)).toMatchObject({ ok: false, error: "cycle" });
  });

  it("rejects ambiguous record IDs and inconsistent links", () => {
    const state = scenario();
    state.records[2]!.fromSurfaceId = "meal-1";
    expect(buildExposureChain(state, state.records[2]!.id)).toMatchObject({ ok: false, error: "invalid-link" });
    state.records.push({ ...state.records[0]! });
    expect(buildExposureChain(state, state.records[0]!.id)).toMatchObject({ ok: false, error: "duplicate-record" });
  });

  it.each(["missing", "ignored", "wrong-target", "wrong-time"])("rejects %s event evidence", corruption => {
    const state = scenario();
    const entry = state.log[1]!;
    if (corruption === "missing") state.log.pop();
    if (corruption === "ignored") entry.effect = "ignored-low-confidence";
    if (corruption === "wrong-time") entry.event.t = 50;
    if (corruption === "wrong-target" && entry.event.kind === "contact") entry.event.b = "meal-1";
    expect(buildExposureChain(state, state.records[2]!.id)).toMatchObject({ ok: false, error: "invalid-event" });
  });
});
