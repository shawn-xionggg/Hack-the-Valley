import { OBJECT_IDS, SURFACES } from "../shared/config";
import type { ExposableSurfaceId } from "../shared/config";
import type { EngineState, SurfaceState } from "../shared/engine-types";

/** Build fresh state for one demo session, using the team's shared definitions. */
export function createObjectRegistry(sessionId: string): EngineState {
  if (!sessionId.trim()) throw new Error("A non-empty session ID is required.");

  const records: EngineState["records"] = [];
  const entries: [ExposableSurfaceId, SurfaceState][] = [];

  for (const id of OBJECT_IDS) {
    // The wash station produces events; it never carries tracked exposure.
    if (id === "wash-station") continue;

    const allergens = [...new Set(SURFACES[id].initialAllergens)];
    const activeRecordIds: string[] = [];

    for (const allergen of allergens) {
      const recordId = `origin:${sessionId}:${id}:${allergen}`;
      activeRecordIds.push(recordId);
      records.push({
        id: recordId,
        surfaceId: id,
        allergen,
        kind: "origin",
        causedByEventId: null,
        fromSurfaceId: null,
        parentRecordId: null,
        t: 0,
        clearedByEventId: null,
      });
    }

    entries.push([id, {
      id,
      status: allergens.length ? "potential-exposure" : "no-tracked-exposure",
      allergens,
      activeRecordIds,
    }]);
  }

  return {
    sessionId,
    // OBJECT_IDS is exhaustive and the only excluded ID is wash-station.
    surfaces: Object.fromEntries(entries) as Record<ExposableSurfaceId, SurfaceState>,
    records,
    alerts: [],
    log: [],
    lastWash: null,
    lastUtensilWash: null,
  };
}
