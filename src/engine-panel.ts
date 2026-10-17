// Dev harness: vision → createEngine → a plain-DOM view of exposure, alerts and chains.
// Person 3's dashboard replaces this; it exists so the live demo path can be tested end to end.
// UI wording follows spec §3.3 exactly. No text may say safe, clean, allergen-free or verified.

import { createEngine } from "./engine";
import { ORDERS } from "./shared/config";
import type { ExposableSurfaceId, ToolSurface } from "./shared/config";
import type { Alert, ChainStep, EngineState, LoggedEvent, SurfaceStatus } from "./shared/engine-types";
import type { ContactEvent, GhostEvent, UtensilTracking, UtensilWashedEvent, WashEvent, WashMethod } from "./shared/events";
import { DEMO_SCRIPT, MOVING_TONGS_SCRIPT } from "./sim/fixtures";

const CARDS: ExposableSurfaceId[] = ["hands", "peanut-source", "tongs-tip", "tongs-handle", "meal-1"];
const LABELS: Record<ExposableSurfaceId, string> = {
  hands: "Hands",
  "peanut-source": "Allergen source",
  "tongs-tip": "Tong tips",
  "tongs-handle": "Tong handle",
  "meal-1": "Meal · Order #4",
};
const STATUS_LABELS: Record<SurfaceStatus, string> = {
  "no-tracked-exposure": "No tracked exposure",
  "potential-exposure": "Potential peanut exposure",
  "action-required": "Action required — hold meal",
};
const WASH_METHODS: Record<WashMethod, string> = {
  "zone-dwell": "zone dwell",
  motion: "washing motion",
  "manual-tap": "manual confirmation",
  "manual-voice": "voice confirmation",
};
/** Spacing between scripted events in SIMULATED mode. */
const SIM_STEP_MS = 1500;

const isTool = (id: ExposableSurfaceId): id is ToolSurface => id === "tongs-tip" || id === "tongs-handle";
/** performance.now() timestamps → wall-clock time for display. */
const clock = (t: number) => new Date(Date.now() - (performance.now() - t)).toLocaleTimeString();
const stamp = () => ({ id: crypto.randomUUID(), t: performance.now() });

function chainText(step: ChainStep): string {
  switch (step.kind) {
    case "origin": return `${LABELS[step.surfaceId]} (${step.allergen})`;
    case "wash": return `Hands washed (detected, not verified) · ${WASH_METHODS[step.method]}`;
    case "transfer":
      // A tool contact never involves the hands (§2), so name it as the tool touching the target.
      if (isTool(step.from) && step.to !== "hands") return `${LABELS[step.from]} touched ${LABELS[step.to]}`;
      if (isTool(step.to) && step.from !== "hands") return `${LABELS[step.to]} touched ${LABELS[step.from]}`;
      return `${LABELS[step.from]} → ${LABELS[step.to]}`;
  }
}

function eventText({ event, effect }: LoggedEvent): string {
  const what = event.kind === "contact" ? `${LABELS[event.a]} ↔ ${LABELS[event.b]} (${Math.round(event.confidence * 100)}%)`
    : event.kind === "wash" ? `Hands washed · ${WASH_METHODS[event.method]}`
    : event.kind === "utensil-washed" ? "Tongs washed · zone dwell"
    : event.kind === "utensil-replaced-confirmed" ? "Tongs replaced (confirmed)"
    : event.kind === "alert-acknowledged" ? "Alert acknowledged"
    : "Session reset";
  return `Last event: ${what} · ${effect.replaceAll("-", " ")} · ${event.source}`;
}

/** Three short tones; the page has had a click (Start camera or a replay), so audio is allowed. */
function chime() {
  try {
    const audio = new AudioContext();
    [880, 660, 880].forEach((frequency, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = frequency;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + i * 0.22);
      osc.stop(audio.currentTime + i * 0.22 + 0.18);
    });
    setTimeout(() => void audio.close(), 1000);
  } catch { /* No audio device: the pulsing card still shows the alert. */ }
}

export interface EnginePanel {
  /** Feed every camera contact/wash here. Ignored while a simulated replay owns the session. */
  onVisionEvent(event: ContactEvent | WashEvent | UtensilWashedEvent): void;
  /** Current tong tracking state, or null while the camera is off. */
  setTracking(tracking: UtensilTracking | null): void;
}

export function mountEnginePanel(container: HTMLElement): EnginePanel {
  const engine = createEngine();
  // Handy from the console while testing on the rig: ghosttraceEngine.getState().
  Object.assign(window, { ghosttraceEngine: engine });
  let tracking: UtensilTracking | null = null;
  let simulated = false;
  let replay: number | undefined;
  let announced = new Set<string>();
  let session = engine.getState().sessionId;

  const order = ORDERS[0];
  container.innerHTML = `
    <div class="panel-heading"><h2>Exposure tracking</h2><span class="pill">DEV HARNESS · ENGINE</span></div>
    <div class="sim-banner" id="sim-banner" hidden>SIMULATED — scripted events, not the camera. Camera events are paused until you reset the session.</div>
    <p class="order-line">${order ? `<strong>${order.displayName}</strong> — ${order.allergies.join(", ")} allergy` : "No orders"}</p>
    <div class="surface-cards" id="surface-cards"></div>
    <div id="alerts"></div>
    <div class="zone-actions engine-actions">
      <button class="text-button" id="manual-wash">Confirm hands washed with soap and water</button>
      <button class="text-button" id="replaced">Confirm tongs replaced</button>
      <button class="text-button" id="reset">Reset session</button>
      <button class="text-button" id="sim-act1">Replay Act 1 (simulated)</button>
      <button class="text-button" id="sim-act2">Replay Act 2 (simulated)</button>
    </div>
    <p class="hint" id="engine-last">No events yet. Exposure is inferred from camera geometry; it is not an allergen test.</p>`;
  const el = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!;

  function card(state: EngineState, id: ExposableSurfaceId): HTMLElement {
    const { status } = state.surfaces[id];
    const node = document.createElement("div");
    node.className = `surface-card ${id === "peanut-source" ? "source" : status}`;
    const title = document.createElement("span");
    title.className = "surface-name";
    title.textContent = LABELS[id];
    const label = document.createElement("strong");
    label.textContent = id === "peanut-source" ? "Allergen source" : STATUS_LABELS[status];
    node.append(title, label);
    const note = (text: string, warn = false) => {
      const line = document.createElement("span");
      line.className = warn ? "surface-note warn" : "surface-note";
      line.textContent = text;
      node.append(line);
    };
    if (id === "hands" && state.lastWash) {
      note(`Hands washed (detected, not verified) · ${WASH_METHODS[state.lastWash.method]} · ${clock(state.lastWash.t)}`);
    }
    if (isTool(id) && tracking === "lost") note("Tong tracking lost — contacts not recorded", true);
    if (isTool(id) && tracking === "fixed") note("Tongs: fixed position");
    return node;
  }

  function alertBlock(alert: Alert): HTMLElement {
    const node = document.createElement("div");
    node.className = `alert-card${alert.acknowledged ? " acknowledged" : ""}`;
    const heading = document.createElement("h3");
    heading.textContent = `Action required — hold meal · ${ORDERS.find(o => o.id === alert.orderId)?.displayName ?? alert.orderId} · ${alert.allergen}`;
    const chain = document.createElement("ol");
    chain.className = "chain";
    if (!alert.chain.length) {
      const item = document.createElement("li");
      item.textContent = "Exposure history unavailable for this alert.";
      chain.append(item);
    }
    for (const step of alert.chain) {
      const item = document.createElement("li");
      item.className = `chain-step ${step.kind}`;
      const text = document.createElement("span");
      text.textContent = chainText(step);
      const time = document.createElement("time");
      time.textContent = step.kind === "origin" ? "start" : clock(step.t);
      item.append(text, time);
      chain.append(item);
    }
    const action = document.createElement("p");
    action.className = "alert-action";
    action.textContent = "Hold this meal and prepare a replacement with appropriate allergen controls.";
    node.append(heading, chain, action);
    if (alert.acknowledged) {
      const done = document.createElement("p");
      done.className = "alert-action";
      done.textContent = `Acknowledged at ${clock(alert.acknowledgedAt ?? alert.t)}. The meal stays on hold until the session is reset.`;
      node.append(done);
    } else {
      const ack = document.createElement("button");
      ack.className = "secondary";
      ack.textContent = "Acknowledge alert";
      ack.addEventListener("click", () => dispatch({ ...stamp(), kind: "alert-acknowledged", alertId: alert.id, source: "manual" }));
      node.append(ack);
    }
    return node;
  }

  function render(state: EngineState) {
    if (state.sessionId !== session) { session = state.sessionId; announced = new Set(); }
    el("surface-cards").replaceChildren(...CARDS.map(id => card(state, id)));
    el("alerts").replaceChildren(...state.alerts.map(alertBlock));
    el("sim-banner").hidden = !simulated;
    const last = state.log.at(-1);
    if (last) el("engine-last").textContent = eventText(last);
    const fresh = state.alerts.filter(alert => !announced.has(alert.id));
    fresh.forEach(alert => announced.add(alert.id));
    if (fresh.some(alert => !alert.acknowledged)) chime();
  }

  function dispatch(event: GhostEvent) { engine.dispatch(event); }

  function stopReplay() {
    if (replay !== undefined) clearTimeout(replay);
    replay = undefined;
  }

  /** SIMULATED mode: a fresh session, then the fixture script through the real engine with live ids and times. */
  function simulate(script: GhostEvent[]) {
    stopReplay();
    simulated = true;
    dispatch({ ...stamp(), kind: "session-reset", source: "sim" });
    const queue = [...script];
    const step = () => {
      const next = queue.shift();
      if (!next) { replay = undefined; return; }
      dispatch({ ...next, ...stamp() });
      replay = window.setTimeout(step, SIM_STEP_MS);
    };
    replay = window.setTimeout(step, SIM_STEP_MS);
  }

  engine.subscribe(render);
  el("manual-wash").addEventListener("click", () =>
    dispatch({ ...stamp(), kind: "wash", method: "manual-tap", source: "manual", verified: false }));
  el("replaced").addEventListener("click", () =>
    dispatch({ ...stamp(), kind: "utensil-replaced-confirmed", utensilId: "tongs", source: "manual" }));
  el("reset").addEventListener("click", () => {
    stopReplay();
    simulated = false;
    dispatch({ ...stamp(), kind: "session-reset", source: "manual" });
  });
  el("sim-act1").addEventListener("click", () => simulate(DEMO_SCRIPT.events));
  el("sim-act2").addEventListener("click", () => simulate(MOVING_TONGS_SCRIPT.events));
  render(engine.getState());

  return {
    onVisionEvent(event) {
      if (!simulated) dispatch(event);
    },
    setTracking(next) {
      if (next === tracking) return;
      tracking = next;
      render(engine.getState());
    },
  };
}
