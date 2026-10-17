import { DEFAULT_TUNING } from "../shared/config";
import type { ExposableSurfaceId } from "../shared/config";
import type { EngineState, ExposureRecord, LogEffect } from "../shared/engine-types";
import type { ContactEvent } from "../shared/events";

/** Contact-only reducer. Inputs must satisfy the shared contract; alerts and interventions are separate steps. */
export function applyContact(
  state: EngineState,
  event: ContactEvent,
  minConfidence = DEFAULT_TUNING.minContactConfidence,
): EngineState {
  const next = structuredClone(state);
  const log = (effect: LogEffect): EngineState => {
    next.log.push({ event: { ...event }, effect });
    return next;
  };

  // Check every logged event, including contacts ignored for low confidence.
  if (state.log.some(entry => entry.event.id === event.id)) {
    return log("ignored-duplicate-id");
  }
  if (event.confidence < minConfidence) return log("ignored-low-confidence");

  // Snapshot both sides before either transfer: no same-contact feedback loops.
  const active = (id: ExposableSurfaceId): ExposureRecord[] => state.records.filter(
    record => record.surfaceId === id && record.clearedByEventId === null,
  );
  const a = active(event.a);
  const b = active(event.b);
  let added = false;

  const transfer = (source: ExposureRecord[], destination: ExposureRecord[], to: ExposableSurfaceId) => {
    const present = new Set(destination.map(record => record.allergen));
    for (const parent of source) {
      if (present.has(parent.allergen)) continue;
      present.add(parent.allergen);
      // Tuple encoding avoids collisions even if event IDs contain punctuation.
      const id = `transfer:${JSON.stringify([state.sessionId, event.id, to, parent.allergen])}`;
      next.records.push({
        id, surfaceId: to, allergen: parent.allergen, kind: "transfer",
        causedByEventId: event.id, fromSurfaceId: parent.surfaceId,
        parentRecordId: parent.id, t: event.t, clearedByEventId: null,
      });
      const surface = next.surfaces[to];
      surface.activeRecordIds.push(id);
      surface.allergens.push(parent.allergen);
      if (surface.status !== "action-required") surface.status = "potential-exposure";
      added = true;
    }
  };

  transfer(a, b, event.b);
  transfer(b, a, event.a);
  return log(added ? "applied" : "no-change");
}
