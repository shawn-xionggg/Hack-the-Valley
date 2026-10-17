import { useSyncExternalStore } from "react";
import type { Engine, EngineState } from "../shared/engine-types";

/** Re-renders after every dispatch. getState() returns the same object until the next dispatch. */
export function useEngineState(engine: Engine): EngineState {
  return useSyncExternalStore(listener => engine.subscribe(listener), engine.getState, engine.getState);
}
