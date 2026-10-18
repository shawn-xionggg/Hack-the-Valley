// GhostTrace dashboard (Person 3): renders EngineState and VisionStatus, and sends the manual events
// (wash, tongs replaced, acknowledge, reset) through engine.dispatch. Spec §3.3 wording lives in labels.ts.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createEngine } from "../engine";
import { ORDERS } from "../shared/config";
import type { LoggedEvent } from "../shared/engine-types";
import type { ContactEvent, GhostEvent, UtensilWashedEvent, WashEvent } from "../shared/events";
import { DEMO_SCRIPT, MOVING_TONGS_SCRIPT } from "../sim/fixtures";
import { chime } from "./chime";
import { AlertPanel } from "./components/AlertPanel";
import { CameraView } from "./components/CameraView";
import { CameraSource } from "./components/CameraSource";
import { EventLog } from "./components/EventLog";
import { EspConnectionPanel } from "./components/EspConnectionPanel";
import { SurfaceCards } from "./components/SurfaceCards";
import { VisionStrip } from "./components/VisionStrip";
import { MANUAL_WASH_BUTTON, MANUAL_WASH_NOTE, SCOPE_NOTE } from "./labels";
import { createSimulator } from "./simulation";
import { useEngineState } from "./useEngineState";
import { useLiveVision } from "./useLiveVision";

const stamp = () => ({ id: crypto.randomUUID(), t: performance.now() });

export function App() {
  const engine = useMemo(() => createEngine(), []);
  const state = useEngineState(engine);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const simulator = useMemo(() => createSimulator(engine, refresh), [engine]);
  /** True from a simulated replay until the next manual reset; camera events are ignored meanwhile. */
  const [simulated, setSimulated] = useState(false);
  const [mirrored, setMirrored] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [archivedLog, setArchivedLog] = useState<LoggedEvent[]>([]);
  const eventLog = useMemo(() => [...archivedLog, ...state.log], [archivedLog, state.log]);

  const dispatch = (event: GhostEvent) => engine.dispatch(event);
  const vision = useLiveVision((event: ContactEvent | WashEvent | UtensilWashedEvent) => { if (!simulated) dispatch(event); });
  const live = vision.phase === "live";
  const tracking = live && vision.frame ? vision.frame.status.utensils.tongs.tracking : null;

  // Handy from the console while testing on the rig: ghosttraceEngine.getState().
  useEffect(() => { Object.assign(window, { ghosttraceEngine: engine }); }, [engine]);
  useEffect(() => () => simulator.cancel(), [simulator]);

  // Chime once per new, unacknowledged alert. Alert ids repeat across sessions, so forget them on reset.
  const announced = useRef({ sessionId: state.sessionId, ids: new Set<string>() });
  useEffect(() => {
    if (announced.current.sessionId !== state.sessionId) announced.current = { sessionId: state.sessionId, ids: new Set() };
    const fresh = state.alerts.filter(alert => !announced.current.ids.has(alert.id));
    fresh.forEach(alert => announced.current.ids.add(alert.id));
    if (fresh.some(alert => !alert.acknowledged)) chime();
  }, [state]);

  // Preserve displayed history across resets without replaying old events into
  // the fresh engine session or changing its duplicate-id/exposure rules.
  const archiveCurrentLog = useCallback(() => {
    const currentLog = engine.getState().log;
    if (currentLog.length) setArchivedLog(previous => [...previous, ...currentLog]);
  }, [engine]);
  const simulate = (script: GhostEvent[]) => {
    archiveCurrentLog();
    setSimulated(true);
    simulator.play(script);
  };
  const reset = useCallback(() => {
    simulator.cancel();
    archiveCurrentLog();
    setSimulated(false);
    engine.dispatch({ ...stamp(), kind: "session-reset", source: "manual" });
  }, [engine, simulator, archiveCurrentLog]);
  const order = ORDERS[0];
  const hasAlert = state.alerts.some(alert => !alert.acknowledged);

  return (
    <div className={`dashboard${simulated ? " is-simulated" : ""}`}>
      {simulated && (
        <div className="sim-banner" role="status">
          SIMULATED — scripted events replayed through the real engine, not the camera.
          {simulator.playing ? " Replay running…" : " Replay finished."} Reset the session to return to live.
          <button className="button banner-button" onClick={reset}>Reset session</button>
        </div>
      )}
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">◌</span> GhostTrace</div>
        {order && (
          <div className={`order-chip${state.surfaces[order.mealId].status === "action-required" ? " alerting" : ""}`}>
            <strong>{order.displayName}</strong> — {order.allergies.map(a => a[0]!.toUpperCase() + a.slice(1)).join(", ")} allergy
          </div>
        )}
        <span className={`mode-pill ${simulated ? "sim" : live ? "live" : "off"}`}>
          {simulated ? "SIMULATED" : live ? "● LIVE CAMERA" : "CAMERA OFF"}
        </span>
      </header>

      <main className="layout">
        <section className="panel camera-panel" aria-label="Camera">
          <CameraView vision={vision} surfaces={state.surfaces} mirrored={mirrored} paused={simulated} />
          <div className="camera-toolbar">
            {vision.phase === "off"
              ? <button className="button primary" onClick={() => vision.start(deviceId || undefined)}>Start camera</button>
              : <button className="button" onClick={() => vision.stop()}>Stop camera</button>}
            {vision.cameras.length > 0 && (
              <CameraSource cameras={vision.cameras} requestedId={deviceId} activeId={vision.activeCameraId}
                onChange={id => {
                  setDeviceId(id);
                  if (vision.phase !== "off") vision.start(id || undefined);
                }} />
            )}
            <label className="check"><input type="checkbox" checked={mirrored} onChange={event => setMirrored(event.target.checked)} /> Mirror</label>
            <a className="link" href="./">Calibrate zones and tongs ↗</a>
          </div>
          <p className={`camera-message${vision.message.error ? " error" : ""}`} role="status">{vision.message.text}</p>
          <VisionStrip frame={live ? vision.frame : null} lastWash={state.lastWash} />
        </section>

        <section className="panel status-panel" aria-label="Tracked exposure">
          <h2>Tracked exposure</h2>
          <SurfaceCards state={state} tracking={tracking}
            onReplaceTongs={() => dispatch({ ...stamp(), kind: "utensil-replaced-confirmed", utensilId: "tongs", source: "manual" })} />
          <h2 className={hasAlert ? "alerting" : undefined}>Alerts</h2>
          <AlertPanel alerts={state.alerts}
            onAcknowledge={alertId => dispatch({ ...stamp(), kind: "alert-acknowledged", alertId, source: "manual" })} />
          <p className="scope-note">{SCOPE_NOTE}</p>
        </section>

        <EspConnectionPanel engine={engine} />

        {/* Operator-only controls stay out of the way: the worker's own action (replacing tongs) is under the cards. */}
        <details className="panel controls-panel">
          <summary><h2>Operator controls</h2></summary>
          <div className="controls">
            <button className="button" onClick={reset}>Reset session</button>
          </div>
          <h2>Wash fallback</h2>
          <div className="controls">
            <button className="button" onClick={() => dispatch({ ...stamp(), kind: "wash", method: "manual-tap", source: "manual", verified: false })}>
              {MANUAL_WASH_BUTTON}
            </button>
          </div>
          <p className="scope-note">{MANUAL_WASH_NOTE}</p>
          <h2>Simulated replay</h2>
          <div className="controls">
            <button className="button" onClick={() => simulate(DEMO_SCRIPT.events)}>Act 1 · exposure outlasts a hand wash</button>
            <button className="button" onClick={() => simulate(MOVING_TONGS_SCRIPT.events)}>Act 2 · moving tongs</button>
            {simulator.playing && <button className="button" onClick={() => simulator.cancel()}>Stop replay</button>}
          </div>
        </details>

        <details className="panel log-panel">
          <summary><h2>Event log <span className="count">{eventLog.length}</span></h2></summary>
          <EventLog log={eventLog} />
        </details>
      </main>
    </div>
  );
}
