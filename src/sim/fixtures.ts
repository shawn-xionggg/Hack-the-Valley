// GhostTrace test fixtures and the canonical demo script.
// Used by: engine unit tests (Person 2), SIMULATED mode (Person 3), and as the
// executable definition of the demo. Spec: GhostTrace-summary-v5.md.

import type { ContactTarget, ExposableSurfaceId, Order, ToolContactTarget, ToolSurface, UtensilId } from "../shared/config";
import { ORDERS } from "../shared/config";
import type { ChainStep, SurfaceStatus } from "../shared/engine-types";
import type { GhostEvent, WashMethod } from "../shared/events";

/** Alert ids are deterministic so fixtures and UIs can reference them: one alert per meal per allergen per session. */
export const alertId = (mealId: string, allergen: string): string => `alert:${mealId}:${allergen}`;

/** Builds a deterministic event list: ids e1, e2, … and t = 1000, 2000, … */
export class ScriptBuilder {
  private n = 0;
  readonly events: GhostEvent[] = [];

  private next(): { id: string; t: number } {
    this.n += 1;
    return { id: `e${this.n}`, t: this.n * 1000 };
  }

  contact(b: ContactTarget, confidence = 1): this {
    this.events.push({ kind: "contact", a: "hands", b, confidence, source: "sim", ...this.next() });
    return this;
  }

  /** A tracked tong part touched a static target (tips in the peanuts, tips on the plate). */
  toolContact(a: ToolSurface, b: ToolContactTarget, confidence = 1): this {
    this.events.push({ kind: "contact", a, b, confidence, source: "sim", ...this.next() });
    return this;
  }

  /** A pair the contract forbids (e.g. tip↔handle), cast past the types to test the engine guard. */
  invalidContact(a: ExposableSurfaceId, b: ExposableSurfaceId): this {
    this.events.push({ kind: "contact", a, b, confidence: 1, source: "sim", ...this.next() } as unknown as GhostEvent);
    return this;
  }

  wash(method: WashMethod = "zone-dwell"): this {
    this.events.push({ kind: "wash", method, source: "sim", verified: false, ...this.next() });
    return this;
  }

  replace(utensilId: UtensilId = "tongs"): this {
    this.events.push({ kind: "utensil-replaced-confirmed", utensilId, source: "sim", ...this.next() });
    return this;
  }

  ack(id: string): this {
    this.events.push({ kind: "alert-acknowledged", alertId: id, source: "sim", ...this.next() });
    return this;
  }

  reset(): this {
    this.events.push({ kind: "session-reset", source: "sim", ...this.next() });
    return this;
  }

  /** Re-send an existing event (same id) to test duplicate handling. */
  repeatLast(): this {
    const last = this.events[this.events.length - 1];
    if (last) this.events.push(last);
    return this;
  }
}

/** Compact, comparable form of a chain: "origin:peanut-source", "hands>tongs-tip", "wash". */
export function formatChain(chain: ChainStep[]): string[] {
  return chain.map((s) => {
    switch (s.kind) {
      case "origin":
        return `origin:${s.surfaceId}`;
      case "transfer":
        return `${s.from}>${s.to}`;
      case "wash":
        return "wash";
    }
  });
}

type Statuses = Partial<Record<ExposableSurfaceId, SurfaceStatus>>;

export interface Expectation {
  statuses?: Statuses;
  alertCount?: number;
  alertAcknowledged?: boolean;
  chain?: string[];
}

export interface Scenario {
  name: string;
  orders?: Order[]; // defaults to ORDERS
  events: GhostEvent[];
  /** Optional per-event expectations, index-aligned with events. */
  afterEach?: (Expectation | null)[];
  /** Expectations after all events are applied. */
  final: Expectation;
}

const N: SurfaceStatus = "no-tracked-exposure";
const P: SurfaceStatus = "potential-exposure";
const A: SurfaceStatus = "action-required";

const s = (hands: SurfaceStatus, tip: SurfaceStatus, handle: SurfaceStatus, meal: SurfaceStatus): Statuses => ({
  hands,
  "tongs-tip": tip,
  "tongs-handle": handle,
  "meal-1": meal,
});

const DEMO_CHAIN = [
  "origin:peanut-source",
  "peanut-source>hands",
  "hands>tongs-tip",
  "wash",
  "tongs-tip>hands",
  "hands>meal-1",
];

// ---------------------------------------------------------------------------
// Canonical demo script (judge demo steps 2–8). SIMULATED mode replays this.
// ---------------------------------------------------------------------------
export const DEMO_SCRIPT: Scenario = {
  name: "1. Demo path: wash does not clean the tongs",
  events: new ScriptBuilder()
    .contact("peanut-source") // judge touches peanut source
    .contact("tongs-tip") // judge touches tong tips
    .wash("zone-dwell") // judge wipes hands at wash station
    .contact("tongs-handle") // judge grips handle (only ever touched by clean hands)
    .contact("tongs-tip") // judge touches tips again
    .contact("meal-1") // judge touches Order #4's meal → ALERT
    .ack(alertId("meal-1", "peanut")).events, // judge acknowledges
  afterEach: [
    { statuses: s(P, N, N, N), alertCount: 0 },
    { statuses: s(P, P, N, N), alertCount: 0 },
    { statuses: s(N, P, N, N), alertCount: 0 },
    { statuses: s(N, P, N, N), alertCount: 0 },
    { statuses: s(P, P, N, N), alertCount: 0 },
    { statuses: s(P, P, N, A), alertCount: 1, alertAcknowledged: false, chain: DEMO_CHAIN },
    { statuses: s(P, P, N, A), alertCount: 1, alertAcknowledged: true },
  ],
  final: { statuses: s(P, P, N, A), alertCount: 1, alertAcknowledged: true, chain: DEMO_CHAIN },
};

const MOVING_CHAIN = ["origin:peanut-source", "peanut-source>tongs-tip", "tongs-tip>meal-1"];

// ---------------------------------------------------------------------------
// Act 2 (moving tongs, after a session reset): the hands never touch a peanut.
// ---------------------------------------------------------------------------
export const MOVING_TONGS_SCRIPT: Scenario = {
  name: "10. Moving tongs: tips carry peanut to the meal without the hands",
  events: new ScriptBuilder()
    .contact("tongs-handle") // judge picks up the tongs by the handle (clean hands)
    .toolContact("tongs-tip", "peanut-source") // dips the tips into the peanuts
    .toolContact("tongs-tip", "meal-1") // serves onto Order #4's plate → ALERT
    .ack(alertId("meal-1", "peanut")).events, // judge acknowledges
  afterEach: [
    { statuses: s(N, N, N, N), alertCount: 0 },
    { statuses: s(N, P, N, N), alertCount: 0 },
    { statuses: s(N, P, N, A), alertCount: 1, alertAcknowledged: false, chain: MOVING_CHAIN },
    { statuses: s(N, P, N, A), alertCount: 1, alertAcknowledged: true },
  ],
  final: { statuses: s(N, P, N, A), alertCount: 1, alertAcknowledged: true, chain: MOVING_CHAIN },
};

export const SCENARIOS: Scenario[] = [
  DEMO_SCRIPT,
  {
    name: "2. Handle contamination is real",
    events: new ScriptBuilder()
      .contact("peanut-source")
      .contact("tongs-handle") // exposed hands expose the handle
      .wash()
      .contact("tongs-handle").events, // clean hands re-exposed via handle
    final: { statuses: s(P, N, P, N), alertCount: 0 },
  },
  {
    name: "3a. Tip/handle isolation: exposed tip never exposes handle",
    events: new ScriptBuilder().contact("peanut-source").contact("tongs-tip").wash().contact("tongs-handle").events,
    final: { statuses: s(N, P, N, N), alertCount: 0 },
  },
  {
    name: "3b. Tip/handle isolation: exposed handle never exposes tip",
    events: new ScriptBuilder().contact("peanut-source").contact("tongs-handle").wash().contact("tongs-tip").events,
    final: { statuses: s(N, N, P, N), alertCount: 0 },
  },
  {
    name: "4. Utensil replacement resets tip and handle together",
    events: new ScriptBuilder()
      .contact("peanut-source")
      .contact("tongs-tip")
      .contact("tongs-handle")
      .replace("tongs").events,
    final: { statuses: s(P, N, N, N), alertCount: 0 },
  },
  {
    name: "5. Duplicates: repeated touches and repeated event ids change nothing",
    events: new ScriptBuilder()
      .contact("peanut-source")
      .contact("peanut-source") // second touch: no new exposure
      .contact("meal-1")
      .repeatLast() // same event id re-sent: ignored
      .contact("meal-1").events, // new touch, meal already exposed: no second alert
    final: { statuses: s(P, N, N, A), alertCount: 1 },
  },
  {
    name: "6. A meal with no allergy-linked order gets exposure but no alert",
    orders: [],
    events: new ScriptBuilder().contact("peanut-source").contact("meal-1").events,
    final: { statuses: s(P, N, N, P), alertCount: 0 },
  },
  {
    name: "7. Acknowledgement does not clear the meal",
    events: new ScriptBuilder()
      .contact("peanut-source")
      .contact("meal-1")
      .ack(alertId("meal-1", "peanut"))
      .wash().events,
    final: { statuses: s(N, N, N, A), alertCount: 1, alertAcknowledged: true },
  },
  {
    name: "8. Low-confidence contacts are ignored",
    events: new ScriptBuilder().contact("peanut-source", 0.3).contact("meal-1").events,
    final: { statuses: s(N, N, N, N), alertCount: 0 },
  },
  {
    name: "9. Session reset clears everything",
    events: new ScriptBuilder().contact("peanut-source").contact("meal-1").reset().events,
    final: { statuses: s(N, N, N, N), alertCount: 0 },
  },
  MOVING_TONGS_SCRIPT,
  {
    name: "11. Tool contacts never leak tip to handle",
    events: new ScriptBuilder().toolContact("tongs-tip", "peanut-source").contact("tongs-handle").events,
    final: { statuses: s(N, P, N, N), alertCount: 0 },
  },
  {
    name: "12. A handle resting in the peanuts exposes the hands that grip it",
    events: new ScriptBuilder().toolContact("tongs-handle", "peanut-source").contact("tongs-handle").events,
    final: { statuses: s(P, N, P, N), alertCount: 0 },
  },
  {
    name: "13. Invalid contact pairs are ignored",
    events: new ScriptBuilder()
      .toolContact("tongs-tip", "peanut-source")
      .invalidContact("tongs-tip", "tongs-handle").events, // logged ignored-invalid-contact
    final: { statuses: s(N, P, N, N), alertCount: 0 },
  },
  {
    name: "14. Replacement clears exposure carried by the tongs alone",
    events: new ScriptBuilder()
      .toolContact("tongs-tip", "peanut-source")
      .replace("tongs")
      .toolContact("tongs-tip", "meal-1").events,
    final: { statuses: s(N, N, N, N), alertCount: 0 },
  },
];

export { ORDERS };
