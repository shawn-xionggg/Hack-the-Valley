import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine";
import type { ExposableSurfaceId } from "../shared/config";
import type { EngineState, SurfaceStatus } from "../shared/engine-types";
import type { UtensilTracking, UtensilWashedEvent } from "../shared/events";
import { DEMO_SCRIPT, MOVING_TONGS_SCRIPT, SCENARIOS, alertId } from "../sim/fixtures";
import type { Scenario } from "../sim/fixtures";
import { App } from "./App";
import { AlertPanel } from "./components/AlertPanel";
import { SurfaceCards } from "./components/SurfaceCards";
import { VisionStrip } from "./components/VisionStrip";
import * as labels from "./labels";
import { createSimulator } from "./simulation";

/** Invariant 5: no UI text says safe, clean, allergen-free or verified. "not verified" is the required wash label. */
function forbiddenWords(text: string): string[] {
  return text.replaceAll("not verified", "").match(/\b(safe|clean|allergen-free|verified)\b/gi) ?? [];
}

const run = (scenario: Scenario): EngineState => {
  const engine = createEngine();
  for (const event of scenario.events) engine.dispatch(event);
  return engine.getState();
};

/**
 * A3 states built by hand, so these tests don't depend on the engine's utensil-washed handling (built in
 * parallel): the engine's state for the events, with the scenario's expected final statuses and the last
 * utensil wash filled in. Once the engine handles the event this changes nothing.
 */
const a3State = (scenario: Scenario): EngineState => {
  const state = run(scenario);
  const surfaces = { ...state.surfaces };
  for (const [id, status] of Object.entries(scenario.final.statuses ?? {}) as [ExposableSurfaceId, SurfaceStatus][]) {
    surfaces[id] = { ...surfaces[id], status };
  }
  const wash = scenario.events.filter((event): event is UtensilWashedEvent => event.kind === "utensil-washed").pop();
  const lastUtensilWash = wash ? { eventId: wash.id, utensilId: wash.utensilId, method: wash.method, t: wash.t } : null;
  return { ...state, surfaces, lastUtensilWash };
};
const A3_SCENARIOS = SCENARIOS.filter(scenario => /^1[5-7]\./.test(scenario.name));

const render = (state: EngineState, tracking: UtensilTracking | null = null) => renderToStaticMarkup(
  <>
    <SurfaceCards state={state} tracking={tracking} onReplaceTongs={() => {}} />
    <AlertPanel alerts={state.alerts} onAcknowledge={() => {}} />
  </>,
);

describe("dashboard wording (spec §3.3)", () => {
  it("uses the exact status labels", () => {
    expect(labels.STATUS_LABELS).toEqual({
      "no-tracked-exposure": "No tracked exposure",
      "potential-exposure": "Potential peanut exposure",
      "action-required": "Action required — hold meal",
    });
    expect(labels.SURFACE_LABELS["peanut-source"]).toBe("Allergen source");
    expect(labels.WASH_LABEL).toBe("Hands washed (detected, not verified)");
    expect(labels.TRACKING_NOTES.lost).toBe("Tong tracking lost — contacts not recorded");
    expect(labels.TRACKING_NOTES.fixed).toBe("Tongs: fixed position");
  });

  it("never says safe, clean, allergen-free or verified in any label", () => {
    const strings = Object.values(labels).flatMap(value =>
      typeof value === "string" ? [value] : typeof value === "object" ? Object.values(value as object).filter(v => typeof v === "string") : []);
    expect(strings.length).toBeGreaterThan(20);
    expect(strings.flatMap(forbiddenWords)).toEqual([]);
  });

  it("never says them on the rendered page, in any demo state", () => {
    expect(forbiddenWords(renderToStaticMarkup(<App />))).toEqual([]);
    for (const scenario of [DEMO_SCRIPT, MOVING_TONGS_SCRIPT]) {
      for (const tracking of [null, "tracked", "lost", "fixed"] as const) {
        expect(forbiddenWords(render(run(scenario), tracking))).toEqual([]);
      }
    }
    expect(A3_SCENARIOS).toHaveLength(3);
    for (const scenario of A3_SCENARIOS) {
      for (const tracking of [null, "tracked", "lost", "fixed"] as const) {
        expect(forbiddenWords(render(a3State(scenario), tracking))).toEqual([]);
      }
    }
  });
});

describe("dashboard rendering", () => {
  it("explains the Act 1 alert with the wash in the chain", () => {
    const state = run(DEMO_SCRIPT);
    const steps = state.alerts[0]!.chain.map(labels.chainStepText);
    expect(steps).toEqual([
      "Allergen source (peanut)",
      "Allergen source → Hands",
      "Hands → Tong tips",
      "Hands washed (detected, not verified) · zone dwell",
      "Tong tips → Hands",
      "Hands → Meal · Order #4",
    ]);
    expect(labels.chainPath(state.alerts[0]!.chain)).toEqual(
      ["Allergen source", "Hands", "Tong tips", "[Hands washed]", "Tong tips", "Hands", "Meal · Order #4"]);
    const html = render(state);
    expect(html).toContain("Action required — hold meal");
    expect(html).toContain("The meal stays on hold until the session is reset.");
    expect(html).not.toContain("Acknowledge alert"); // the script acknowledged it
  });

  it("labels Act 2's tool contacts as the tongs touching things", () => {
    const state = run(MOVING_TONGS_SCRIPT);
    expect(state.alerts[0]!.chain.map(labels.chainStepText)).toEqual([
      "Allergen source (peanut)",
      "Tong tips touched Allergen source",
      "Tong tips touched Meal · Order #4",
    ]);
  });

  it("badges the tong cards while tracking is lost, so No tracked exposure never stands alone", () => {
    const html = render(run({ ...MOVING_TONGS_SCRIPT, events: [] }), "lost");
    expect(html.match(/Tong tracking lost — contacts not recorded/g)).toHaveLength(2);
    expect(render(run({ ...MOVING_TONGS_SCRIPT, events: [] }), "tracked")).not.toContain("Tong tracking lost");
    expect(render(run({ ...MOVING_TONGS_SCRIPT, events: [] }), "fixed").match(/Tongs: fixed position/g)).toHaveLength(2);
  });

  it("offers tong replacement only while a tong part has tracked exposure", () => {
    expect(render(run({ ...DEMO_SCRIPT, events: [] }))).not.toContain(labels.TONGS_REPLACE_BUTTON);
    expect(render(run(DEMO_SCRIPT))).toContain(labels.TONGS_REPLACE_BUTTON);
    expect(render(run(MOVING_TONGS_SCRIPT))).toContain(labels.TONGS_REPLACE_PROMPT);
    const replaced = run({ ...DEMO_SCRIPT, events: [...DEMO_SCRIPT.events,
      { id: "r1", t: 99_000, kind: "utensil-replaced-confirmed", utensilId: "tongs", source: "manual" }] });
    expect(render(replaced)).not.toContain(labels.TONGS_REPLACE_BUTTON);
  });

  it("shows the utensil wash on both tong cards once there is one, and not before (A3)", () => {
    expect(labels.UTENSIL_WASH_LABEL).toBe("Tongs washed (detected, not verified)");
    const label = /Tongs washed \(detected, not verified\) · zone dwell · /g;
    for (const scenario of A3_SCENARIOS) {
      const before = { ...scenario, events: scenario.events.slice(0, scenario.events.findIndex(e => e.kind === "utensil-washed")) };
      expect(render(a3State(before))).not.toContain(labels.UTENSIL_WASH_LABEL);
      for (const tracking of [null, "tracked", "lost", "fixed"] as const) {
        const html = render(a3State(scenario), tracking);
        expect(html.match(label)).toHaveLength(2);
        if (tracking === "lost") expect(html.match(/Tong tracking lost — contacts not recorded/g)).toHaveLength(2);
        if (tracking === "fixed") expect(html.match(/Tongs: fixed position/g)).toHaveLength(2);
      }
    }
    expect(render(run(DEMO_SCRIPT))).not.toContain(labels.UTENSIL_WASH_LABEL); // Act 1's hand wash isn't a utensil wash
  });

  it("offers the tong reset after a utensil wash only while the tongs are exposed again (A3)", () => {
    const [cleared, rewashed, mealHeld] = A3_SCENARIOS.map(a3State) as [EngineState, EngineState, EngineState];
    expect(render(cleared)).not.toContain(labels.TONGS_REPLACE_BUTTON); // 15: hands, tip and handle all reset
    expect(render(rewashed)).toContain(labels.TONGS_REPLACE_PROMPT); // 16: the unwashed hands re-exposed the tips
    expect(render(mealHeld)).not.toContain(labels.TONGS_REPLACE_BUTTON); // 17: the meal stays held, the tongs don't
    expect(render(mealHeld)).toContain("Action required — hold meal");
    expect(labels.TONGS_REPLACE_PROMPT).toMatch(/sink/);
  });

  it("shows the tong dwell beside the hand ring only while the tongs are in the sink (A3)", () => {
    const frame = (washProgress: number, utensilWashProgress: number) => ({
      fingertips: [], jawPoints: null,
      status: { t: 0, handsVisible: 2, activeZones: [], washProgress, utensilWashProgress, fps: 20, activeToolContacts: [],
        utensils: { tongs: { tracking: "tracked" as const, parts: null, lastSeenT: 0 } } },
    });
    const strip = (washProgress: number, utensilWashProgress: number) =>
      renderToStaticMarkup(<VisionStrip frame={frame(washProgress, utensilWashProgress)} lastWash={null} />);
    expect(strip(0.5, 0)).not.toContain(labels.UTENSIL_WASH_ARIA);
    expect(strip(0.5, 0)).toContain(labels.SINK_PROMPTS.hands);
    const both = strip(0.5, 0.4);
    expect(both).toContain(labels.UTENSIL_WASH_ARIA);
    expect(both).toContain('aria-valuenow="40"');
    expect(both).toContain(labels.SINK_PROMPTS.utensil);
    expect(both).not.toMatch(/wash station/i);
    expect(forbiddenWords(both)).toEqual([]);
    expect(renderToStaticMarkup(<VisionStrip frame={null} lastWash={null} />)).toContain(labels.SINK_PROMPTS.off);
  });

  it("offers acknowledgement until the alert is acknowledged", () => {
    const events = DEMO_SCRIPT.events.filter(event => event.kind !== "alert-acknowledged");
    const html = render(run({ ...DEMO_SCRIPT, events }));
    expect(html).toContain("Acknowledge alert");
    expect(html).toContain("Hold this meal and prepare a replacement");
  });
});

describe("SIMULATED replay", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("resets, then plays the script through the real engine one step at a time", () => {
    vi.useFakeTimers();
    const engine = createEngine();
    engine.dispatch({ id: "x", t: 0, kind: "contact", a: "hands", b: "peanut-source", confidence: 1, source: "camera" });
    const onChange = vi.fn();
    const sim = createSimulator(engine, onChange, 100);
    sim.play(DEMO_SCRIPT.events);
    expect(sim.playing).toBe(true);
    expect(engine.getState().log.map(entry => entry.event.kind)).toEqual(["session-reset"]);
    expect(engine.getState().surfaces.hands.status).toBe("no-tracked-exposure");

    vi.advanceTimersByTime(100 * 5);
    expect(engine.getState().alerts).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(engine.getState().alerts.map(alert => alert.id)).toEqual([alertId("meal-1", "peanut")]);
    vi.advanceTimersByTime(100);
    expect(sim.playing).toBe(false);
    const state = engine.getState();
    expect(state.surfaces["meal-1"].status).toBe("action-required");
    expect(state.alerts[0]!.acknowledged).toBe(true);
    expect(state.log.every(entry => entry.effect !== "ignored-duplicate-id")).toBe(true);
    expect(onChange).toHaveBeenCalled();
  });

  it("replays twice without the second run's events being dropped as duplicates", () => {
    vi.useFakeTimers();
    const engine = createEngine();
    const sim = createSimulator(engine, () => {}, 100);
    sim.play(MOVING_TONGS_SCRIPT.events);
    vi.advanceTimersByTime(1000);
    sim.play(MOVING_TONGS_SCRIPT.events);
    vi.advanceTimersByTime(1000);
    expect(engine.getState().alerts).toHaveLength(1);
    expect(engine.getState().surfaces["meal-1"].status).toBe("action-required");
  });

  it("cancel stops dispatching", () => {
    vi.useFakeTimers();
    const engine = createEngine();
    const sim = createSimulator(engine, () => {}, 100);
    sim.play(DEMO_SCRIPT.events);
    vi.advanceTimersByTime(100);
    sim.cancel();
    vi.advanceTimersByTime(10_000);
    expect(sim.playing).toBe(false);
    expect(engine.getState().log).toHaveLength(2); // the reset and the first step
  });
});
