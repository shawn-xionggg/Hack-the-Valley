import type { Engine } from "../shared/engine-types";

/** The physical button performs the same manual acknowledgement as the dashboard. */
export function acknowledgeHardwareAlerts(engine: Engine): void {
  for (const alert of engine.getState().alerts.filter(alert => !alert.acknowledged)) {
    engine.dispatch({
      kind: "alert-acknowledged",
      alertId: alert.id,
      id: crypto.randomUUID(),
      t: performance.now(),
      source: "manual",
    });
  }
}
