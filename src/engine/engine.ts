import { DEFAULT_TUNING, ORDERS, UTENSILS } from "../shared/config";
import type { Order, Tuning, UtensilId } from "../shared/config";
import type { Alert, ChainStep, CreateEngine, EngineState, LogEffect, SurfaceStatus } from "../shared/engine-types";
import type { GhostEvent } from "../shared/events";
import { buildExposureChain } from "./history";
import { createObjectRegistry } from "./registry";
import { applyContact } from "./transfer";

interface Context { orders: Order[]; tuning: Tuning; nextSessionId: () => string }

/** Surfaces are a projection of the records and alerts; rebuilding them keeps clears and alerts consistent. */
function deriveSurfaces(state: EngineState): EngineState {
  const alerted = new Set<string>(state.alerts.map(alert => alert.mealId));
  for (const surface of Object.values(state.surfaces)) {
    const active = state.records.filter(record => record.surfaceId === surface.id && record.clearedByEventId === null);
    surface.activeRecordIds = active.map(record => record.id);
    surface.allergens = [...new Set(active.map(record => record.allergen))];
    const status: SurfaceStatus = alerted.has(surface.id) ? "action-required"
      : active.length ? "potential-exposure" : "no-tracked-exposure";
    surface.status = status;
  }
  return state;
}

/** Recorded ancestry plus every wash that cleared a record on that path, origin first, then by time. */
function alertChain(state: EngineState, recordId: string): ChainStep[] {
  const result = buildExposureChain(state, recordId);
  // An alert without an explanation is still an alert; the dashboard shows the chain as unavailable.
  if (!result.ok) return [];
  const path = new Set(result.chain.flatMap(step => step.kind === "wash" ? [] : [step.recordId]));
  const washIds = new Set(state.records.flatMap(record =>
    path.has(record.id) && record.clearedByEventId !== null ? [record.clearedByEventId] : []));
  const washes: ChainStep[] = state.log.flatMap(({ event, effect }) =>
    event.kind === "wash" && effect === "applied" && washIds.has(event.id)
      ? [{ kind: "wash" as const, eventId: event.id, method: event.method, t: event.t }] : []);
  // Stable sort: at equal times a transfer stays ahead of the wash that later cleared it.
  const time = (step: ChainStep) => step.kind === "origin" ? -Infinity : step.t;
  return [...result.chain, ...washes].sort((x, y) => time(x) - time(y));
}

/** Step 4 of §3.5: at most one alert per meal per allergen per session. */
function raiseAlerts(state: EngineState, event: GhostEvent, orders: Order[]) {
  for (const order of orders) for (const allergen of order.allergies) {
    const id = `alert:${order.mealId}:${allergen}`;
    if (state.alerts.some(alert => alert.id === id)) continue;
    const record = state.records.find(r =>
      r.surfaceId === order.mealId && r.allergen === allergen && r.clearedByEventId === null);
    if (!record) continue;
    const alert: Alert = { id, orderId: order.id, mealId: order.mealId, allergen,
      triggeredByEventId: event.id, t: event.t, acknowledged: false, acknowledgedAt: null,
      chain: alertChain(state, record.id) };
    state.alerts.push(alert);
  }
}

/** Marks every active record on the utensil's surfaces as cleared by `eventId`; true if any was. */
function clearUtensil(state: EngineState, utensilId: UtensilId, eventId: string): boolean {
  const parts = new Set<string>(UTENSILS[utensilId] ?? []);
  let cleared = false;
  for (const record of state.records) {
    if (parts.has(record.surfaceId) && record.clearedByEventId === null) {
      record.clearedByEventId = eventId;
      cleared = true;
    }
  }
  return cleared;
}

/** One event → next state. Pure apart from `nextSessionId`, which is deterministic per engine. */
function reduce(state: EngineState, event: GhostEvent, ctx: Context): EngineState {
  const seen = state.log.some(entry => entry.event.id === event.id);
  const next = structuredClone(state);
  const log = (effect: LogEffect) => { next.log.push({ event: { ...event }, effect }); return next; };
  if (seen) return log("ignored-duplicate-id");

  switch (event.kind) {
    case "contact": {
      const applied = applyContact(state, event, ctx.tuning.minContactConfidence);
      if (applied.log.at(-1)?.effect === "applied") raiseAlerts(applied, event, ctx.orders);
      return deriveSurfaces(applied);
    }
    case "wash": {
      // Invariant 1: a wash only ever clears hands.
      for (const record of next.records) {
        if (record.surfaceId === "hands" && record.clearedByEventId === null) record.clearedByEventId = event.id;
      }
      next.lastWash = { eventId: event.id, method: event.method, t: event.t };
      return deriveSurfaces(log("applied"));
    }
    case "utensil-washed": {
      // A3: clears every surface of the utensil, like a replacement; hands, meals and alerts are untouched.
      clearUtensil(next, event.utensilId, event.id);
      next.lastUtensilWash = { eventId: event.id, utensilId: event.utensilId, method: event.method, t: event.t };
      return deriveSurfaces(log("applied"));
    }
    case "utensil-replaced-confirmed": {
      const cleared = clearUtensil(next, event.utensilId, event.id);
      return deriveSurfaces(log(cleared ? "applied" : "no-change"));
    }
    case "alert-acknowledged": {
      // Invariant 4: acknowledgement changes the alert only, never exposure or meal status.
      const alert = next.alerts.find(a => a.id === event.alertId);
      if (!alert) return log("ignored-unknown-alert");
      if (alert.acknowledged) return log("no-change");
      alert.acknowledged = true;
      alert.acknowledgedAt = event.t;
      return log("applied");
    }
    case "session-reset": {
      const fresh = createObjectRegistry(ctx.nextSessionId());
      fresh.log.push({ event: { ...event }, effect: "applied" });
      return fresh;
    }
    default:
      // Unknown kinds only reach here through casts or bad JSON.
      return log("no-change");
  }
}

export const createEngine: CreateEngine = (options = {}) => {
  let sessions = 0;
  const ctx: Context = {
    orders: options.orders ?? ORDERS,
    tuning: { ...DEFAULT_TUNING, ...options.tuning },
    nextSessionId: () => `session-${++sessions}`,
  };
  let state = createObjectRegistry(ctx.nextSessionId());
  const listeners = new Set<(state: EngineState) => void>();

  return {
    dispatch(event) {
      try {
        state = reduce(state, event, ctx);
      } catch (error) {
        // dispatch never throws: a malformed event leaves state untouched.
        console.error("GhostTrace engine ignored a malformed event.", event, error);
      }
      for (const listener of listeners) {
        try { listener(state); } catch (error) { console.error("GhostTrace engine listener failed.", error); }
      }
      return state;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
