import type { Engine } from "../shared/engine-types";

/** One physical press: acknowledge a flashing alert, then reset an acknowledged meal. */
export function handleEspButton(engine: Engine): void {
  const state = engine.getState();
  const alerts = state.alerts.filter(alert => state.surfaces[alert.mealId].status === "action-required");
  const pending = alerts.filter(alert => !alert.acknowledged);
  const stamp = () => ({ id: crypto.randomUUID(), t: performance.now(), source: "manual" as const });
  if (pending.length) {
    for (const alert of pending) {
      engine.dispatch({ ...stamp(), kind: "alert-acknowledged", alertId: alert.id });
    }
    return;
  }
  for (const mealId of new Set(alerts.map(alert => alert.mealId))) {
    engine.dispatch({ ...stamp(), kind: "meal-reset", mealId });
  }
}
