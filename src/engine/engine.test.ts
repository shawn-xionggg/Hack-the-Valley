import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "../shared/engine-types";
import type { GhostEvent } from "../shared/events";
import { DEMO_SCRIPT, SCENARIOS, ScriptBuilder, alertId, formatChain } from "../sim/fixtures";
import type { Expectation } from "../sim/fixtures";
import { createEngine } from "./engine";

function check(state: EngineState, expected: Expectation, where: string) {
  for (const [id, status] of Object.entries(expected.statuses ?? {})) {
    expect(state.surfaces[id as keyof EngineState["surfaces"]].status, `${where}: ${id}`).toBe(status);
  }
  if (expected.alertCount !== undefined) expect(state.alerts, `${where}: alerts`).toHaveLength(expected.alertCount);
  if (expected.alertAcknowledged !== undefined) expect(state.alerts[0]?.acknowledged, `${where}: ack`).toBe(expected.alertAcknowledged);
  if (expected.chain) expect(formatChain(state.alerts[0]?.chain ?? []), `${where}: chain`).toEqual(expected.chain);
}

describe("createEngine acceptance scenarios", () => {
  it.each(SCENARIOS.map(scenario => [scenario.name, scenario] as const))("%s", (_name, scenario) => {
    const engine = createEngine({ orders: scenario.orders });
    scenario.events.forEach((event, i) => {
      const state = engine.dispatch(event);
      const expected = scenario.afterEach?.[i];
      if (expected) check(state, expected, `after event ${i + 1} (${event.kind})`);
    });
    check(engine.getState(), scenario.final, "final");
  });
});

describe("createEngine", () => {
  it("logs every event with an effect, and ignores a repeated id of any kind", () => {
    const engine = createEngine();
    const wash: GhostEvent = { id: "w", t: 1, kind: "wash", method: "manual-tap", source: "manual", verified: false };
    engine.dispatch(wash);
    const state = engine.dispatch(wash);
    expect(state.log.map(entry => entry.effect)).toEqual(["applied", "ignored-duplicate-id"]);
    expect(state.lastWash).toEqual({ eventId: "w", method: "manual-tap", t: 1 });
  });

  it("reports an unknown alert id without changing anything else", () => {
    const engine = createEngine();
    const state = engine.dispatch({ id: "a", t: 1, kind: "alert-acknowledged", alertId: "alert:nope:peanut", source: "manual" });
    expect(state.log.at(-1)!.effect).toBe("ignored-unknown-alert");
    expect(state.alerts).toEqual([]);
  });

  it("keeps cleared records in history; only session reset drops them", () => {
    const engine = createEngine();
    for (const event of new ScriptBuilder().contact("peanut-source").wash().events) engine.dispatch(event);
    const hands = engine.getState().records.filter(record => record.surfaceId === "hands");
    expect(hands).toHaveLength(1);
    expect(hands[0]!.clearedByEventId).toBe("e2");
    expect(engine.getState().surfaces.hands.status).toBe("no-tracked-exposure");
  });

  it("starts a new session on reset, with a fresh origin and the reset as its first log entry", () => {
    const engine = createEngine();
    const before = engine.getState().sessionId;
    const after = engine.dispatch({ id: "r", t: 1, kind: "session-reset", source: "manual" });
    expect(after.sessionId).not.toBe(before);
    expect(after.records.map(record => record.kind)).toEqual(["origin"]);
    expect(after.log).toEqual([{ event: expect.objectContaining({ id: "r" }), effect: "applied" }]);
  });

  it("is a pure function of the event log: replaying gives the same state", () => {
    const run = () => {
      const engine = createEngine();
      for (const event of DEMO_SCRIPT.events) engine.dispatch(event);
      return engine.getState();
    };
    expect(run()).toEqual(run());
  });

  it("returns a new state object per dispatch and leaves earlier states untouched", () => {
    const engine = createEngine();
    const first = engine.getState();
    const second = engine.dispatch(new ScriptBuilder().contact("peanut-source").events[0]!);
    expect(second).not.toBe(first);
    expect(first.surfaces.hands.status).toBe("no-tracked-exposure");
  });

  it("notifies subscribers after every dispatch until they unsubscribe", () => {
    const engine = createEngine();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const [one, two] = new ScriptBuilder().contact("peanut-source").contact("meal-1").events;
    engine.dispatch(one!);
    unsubscribe();
    engine.dispatch(two!);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it("never throws on malformed input or a failing listener", () => {
    const engine = createEngine();
    vi.spyOn(console, "error").mockImplementation(() => {});
    engine.subscribe(() => { throw new Error("listener"); });
    expect(() => engine.dispatch(null as unknown as GhostEvent)).not.toThrow();
    expect(() => engine.dispatch({ id: "x", t: 1, kind: "mystery" } as unknown as GhostEvent)).not.toThrow();
    expect(engine.getState().log.at(-1)!.effect).toBe("no-change");
    vi.restoreAllMocks();
  });

  it("raises the alert on the triggering contact with its time and order", () => {
    const engine = createEngine();
    for (const event of new ScriptBuilder().contact("peanut-source").contact("meal-1").events) engine.dispatch(event);
    expect(engine.getState().alerts).toEqual([expect.objectContaining({
      id: alertId("meal-1", "peanut"), orderId: "order-4", triggeredByEventId: "e2", t: 2000, acknowledged: false,
    })]);
  });
});
