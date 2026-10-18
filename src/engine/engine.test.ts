import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "../shared/engine-types";
import type { AllosEvent } from "../shared/events";
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
    const wash: AllosEvent = { id: "w", t: 1, kind: "wash", method: "manual-tap", source: "manual", verified: false };
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

  it("resets only the meal, retains history and wash state, and re-arms deterministically", () => {
    const engine = createEngine();
    const events = new ScriptBuilder().wash().utensilWash()
      .toolContact("tongs-tip", "peanut-source").toolContact("tongs-tip", "meal-1").events;
    events.forEach(event => engine.dispatch(event));
    const before = engine.getState();
    const reset: AllosEvent = { kind: "meal-reset", mealId: "meal-1", id: "meal-replacement", t: 5000, source: "manual" };
    const after = engine.dispatch(reset);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.lastWash).toEqual(before.lastWash);
    expect(after.lastUtensilWash).toEqual(before.lastUtensilWash);
    expect(after.alerts).toEqual([]);
    expect(after.records).toHaveLength(before.records.length);
    expect(after.records.filter(record => record.surfaceId === "meal-1"))
      .toEqual(before.records.filter(record => record.surfaceId === "meal-1")
        .map(record => ({ ...record, clearedByEventId: reset.id })));
    expect(before.records.find(record => record.surfaceId === "meal-1")?.clearedByEventId).toBeNull();
    expect(after.records.filter(record => record.surfaceId !== "meal-1"))
      .toEqual(before.records.filter(record => record.surfaceId !== "meal-1"));
    for (const id of ["hands", "tongs-tip", "tongs-handle", "peanut-source"] as const) {
      expect(after.surfaces[id]).toEqual(before.surfaces[id]);
    }
    expect(after.surfaces["meal-1"].status).toBe("no-tracked-exposure");
    expect(after.log.slice(0, -1)).toEqual(before.log);
    const duplicate = engine.dispatch(reset);
    expect(duplicate.log.at(-1)?.effect).toBe("ignored-duplicate-id");
    expect(duplicate.records).toEqual(after.records);
    const contact: AllosEvent = { kind: "contact", a: "tongs-tip", b: "meal-1", confidence: 1,
      id: "replacement-contact", t: 6000, source: "camera" };
    const exposedAgain = engine.dispatch(contact);
    expect(exposedAgain.alerts[0]?.id).not.toBe(before.alerts[0]?.id);
    expect(exposedAgain.alerts[0]?.acknowledged).toBe(false);
    expect(exposedAgain.alerts[0]?.chain.length).toBeGreaterThan(0);
    const replay = createEngine();
    for (const { event } of exposedAgain.log) replay.dispatch(event);
    expect(replay.getState()).toEqual(exposedAgain);
  });

  it("does not clear another surface when a malformed meal-reset names it", () => {
    const engine = createEngine();
    new ScriptBuilder().contact("peanut-source").events.forEach(event => engine.dispatch(event));
    const before = engine.getState();
    const after = engine.dispatch({ kind: "meal-reset", mealId: "hands", id: "bad-meal", t: 2000,
      source: "manual" } as unknown as AllosEvent);
    expect(after.records).toEqual(before.records);
    expect(after.surfaces).toEqual(before.surfaces);
    expect(after.log.at(-1)?.effect).toBe("no-change");
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
    expect(() => engine.dispatch(null as unknown as AllosEvent)).not.toThrow();
    expect(() => engine.dispatch({ id: "x", t: 1, kind: "mystery" } as unknown as AllosEvent)).not.toThrow();
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

describe("createEngine utensil wash (A3)", () => {
  const run = (builder: ScriptBuilder) => {
    const engine = createEngine();
    for (const event of builder.events) engine.dispatch(event);
    return engine.getState();
  };
  /** Act 2 up to the alert, then the sink: hand wash, utensil wash. */
  const act2ThenSink = () => new ScriptBuilder()
    .contact("tongs-handle")
    .toolContact("tongs-tip", "peanut-source")
    .toolContact("tongs-tip", "meal-1")
    .wash()
    .utensilWash();

  it("clears tip and handle, records lastUtensilWash, and logs applied even with nothing to clear", () => {
    const engine = createEngine();
    for (const event of new ScriptBuilder().contact("peanut-source").contact("tongs-tip").contact("tongs-handle").events) {
      engine.dispatch(event);
    }
    const washed = engine.dispatch({ id: "u", t: 9, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell", source: "camera", verified: false });
    const tongRecords = washed.records.filter(record => record.surfaceId === "tongs-tip" || record.surfaceId === "tongs-handle");
    expect(tongRecords.length).toBeGreaterThan(0);
    expect(tongRecords.every(record => record.clearedByEventId === "u")).toBe(true);
    expect(washed.lastUtensilWash).toEqual({ eventId: "u", utensilId: "tongs", method: "zone-dwell", t: 9 });
    expect(washed.log.at(-1)!.effect).toBe("applied");

    const again = engine.dispatch({ id: "u2", t: 10, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell", source: "camera", verified: false });
    expect(again.log.at(-1)!.effect).toBe("applied");
    expect(again.lastUtensilWash?.eventId).toBe("u2");
  });

  it("ignores a repeated utensil-washed id", () => {
    const engine = createEngine();
    const event: AllosEvent = { id: "u", t: 1, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell", source: "sim", verified: false };
    engine.dispatch(event);
    const state = engine.dispatch({ ...event, t: 2 });
    expect(state.log.map(entry => entry.effect)).toEqual(["applied", "ignored-duplicate-id"]);
    expect(state.lastUtensilWash).toEqual({ eventId: "u", utensilId: "tongs", method: "zone-dwell", t: 1 });
  });

  it("clears lastUtensilWash on session reset", () => {
    const engine = createEngine();
    expect(engine.getState().lastUtensilWash).toBeNull();
    for (const event of new ScriptBuilder().utensilWash().events) engine.dispatch(event);
    expect(engine.getState().lastUtensilWash).not.toBeNull();
    const after = engine.dispatch({ id: "r", t: 99_000, kind: "session-reset", source: "manual" });
    expect(after.lastUtensilWash).toBeNull();
    expect(after.lastWash).toBeNull();
  });

  it("leaves hands records and lastWash untouched on its own", () => {
    const before = run(new ScriptBuilder().contact("peanut-source").contact("tongs-tip"));
    const after = run(new ScriptBuilder().contact("peanut-source").contact("tongs-tip").utensilWash());
    const hands = (state: EngineState) => state.records.filter(record => record.surfaceId === "hands");
    expect(hands(after)).toEqual(hands(before));
    expect(hands(after).every(record => record.clearedByEventId === null)).toBe(true);
    expect(after.surfaces.hands.status).toBe("potential-exposure");
    expect(after.lastWash).toBeNull();
  });

  it("never touches the meal, its records or its alert, acknowledged or not", () => {
    const alerted = run(new ScriptBuilder()
      .contact("tongs-handle")
      .toolContact("tongs-tip", "peanut-source")
      .toolContact("tongs-tip", "meal-1"));
    const id = alertId("meal-1", "peanut");
    for (const acknowledge of [false, true]) {
      const builder = new ScriptBuilder()
        .contact("tongs-handle")
        .toolContact("tongs-tip", "peanut-source")
        .toolContact("tongs-tip", "meal-1");
      const engine = createEngine();
      for (const event of builder.events) engine.dispatch(event);
      if (acknowledge) engine.dispatch({ id: "ack", t: 3500, kind: "alert-acknowledged", alertId: id, source: "manual" });
      const beforeWash = engine.getState();
      const state = engine.dispatch({ id: "u", t: 4000, kind: "utensil-washed", utensilId: "tongs", method: "zone-dwell", source: "sim", verified: false });
      const meal = (s: EngineState) => s.records.filter(record => record.surfaceId === "meal-1");
      expect(meal(state)).toEqual(meal(beforeWash));
      expect(meal(state).every(record => record.clearedByEventId === null)).toBe(true);
      expect(state.surfaces["meal-1"]).toEqual(beforeWash.surfaces["meal-1"]);
      expect(state.surfaces["meal-1"].status).toBe("action-required");
      expect(state.alerts).toEqual(beforeWash.alerts);
      expect(state.alerts[0]?.acknowledged).toBe(acknowledge);
      expect(state.alerts[0]?.chain).toEqual(alerted.alerts[0]?.chain);
    }
  });

  it("never appears as a chain step", () => {
    const state = run(act2ThenSink());
    const utensilWashIds = new Set(state.log.flatMap(({ event }) => event.kind === "utensil-washed" ? [event.id] : []));
    expect(utensilWashIds.size).toBe(1);
    for (const alert of state.alerts) {
      for (const step of alert.chain) if (step.kind === "wash") expect(utensilWashIds.has(step.eventId)).toBe(false);
    }
    // The handle re-exposes washed hands, so the chain has a hand wash; a utensil wash afterwards
    // clears the handle record on that path but still isn't inserted.
    const reexposed = new ScriptBuilder()
      .contact("peanut-source")
      .contact("tongs-handle")
      .wash()
      .contact("tongs-handle")
      .contact("meal-1"); // ALERT
    const atAlert = run(reexposed);
    const after = run(reexposed.wash().utensilWash());
    expect(atAlert.alerts).toHaveLength(1);
    expect(atAlert.alerts[0]!.chain.filter(step => step.kind === "wash").map(step => step.eventId)).toEqual(["e3"]);
    expect(after.records.find(record => record.surfaceId === "tongs-handle")?.clearedByEventId).toBe("e7");
    expect(after.alerts).toEqual(atAlert.alerts);
  });

  it("stays a pure function of the event log with utensil washes in it", () => {
    const script = () => act2ThenSink().contact("tongs-handle").toolContact("tongs-tip", "peanut-source").wash().utensilWash();
    expect(run(script())).toEqual(run(script()));
  });

  it("keeps invariant 1: a wash alone never clears tong records", () => {
    const state = run(new ScriptBuilder().contact("peanut-source").contact("tongs-tip").contact("tongs-handle").wash());
    const tongs = state.records.filter(record => record.surfaceId === "tongs-tip" || record.surfaceId === "tongs-handle");
    expect(tongs.length).toBeGreaterThan(0);
    expect(tongs.every(record => record.clearedByEventId === null)).toBe(true);
    expect(state.surfaces["tongs-tip"].status).toBe("potential-exposure");
    expect(state.surfaces["tongs-handle"].status).toBe("potential-exposure");
    expect(state.lastUtensilWash).toBeNull();
  });
});
