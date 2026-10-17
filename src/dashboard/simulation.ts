// SIMULATED mode: replay a fixture script through the real engine on a timer, with live ids and times.
// The dashboard shows a banner the whole time a simulated session is active (spec §3.3, §10 item 9).

import type { Engine } from "../shared/engine-types";
import type { GhostEvent } from "../shared/events";

/** Spacing between scripted events: long enough to narrate each step. */
export const SIM_STEP_MS = 1500;

export interface Simulator {
  /** Reset the session, then dispatch the script's events one per stepMs. Cancels any replay in progress. */
  play(script: readonly GhostEvent[]): void;
  /** Stop dispatching. The session stays simulated until the caller resets it. */
  cancel(): void;
  /** True while events are still queued. */
  readonly playing: boolean;
}

const stamp = () => ({ id: crypto.randomUUID(), t: performance.now() });

export function createSimulator(engine: Engine, onChange: () => void, stepMs = SIM_STEP_MS): Simulator {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    onChange();
  };

  return {
    play(script) {
      cancel();
      engine.dispatch({ ...stamp(), kind: "session-reset", source: "sim" });
      const queue = [...script];
      const step = () => {
        const next = queue.shift();
        // Fixture ids (e1, e2, …) would collide across replays; fresh ones keep the duplicate check meaningful.
        if (next) engine.dispatch({ ...next, ...stamp() });
        timer = queue.length ? setTimeout(step, stepMs) : undefined;
        if (!timer) onChange();
      };
      timer = setTimeout(step, stepMs);
      onChange();
    },
    cancel,
    get playing() { return timer !== undefined; },
  };
}
