import type { ExposableSurfaceId } from "../../shared/config";
import type { EngineState } from "../../shared/engine-types";
import type { UtensilTracking } from "../../shared/events";
import {
  SOURCE_LABEL, STATUS_LABELS, SURFACE_LABELS, SURFACE_ORDER, TRACKING_NOTES,
  WASH_LABEL, WASH_METHODS, clockTime, utensilWashText,
} from "../labels";

interface Props {
  state: EngineState;
  /** Live tong tracking, or null while the camera is off. */
  tracking: UtensilTracking | null;
}

const isTool = (id: ExposableSurfaceId) => id === "tongs-tip" || id === "tongs-handle";

/** Tongs reset only through the sink wash with the hands (A3); there's no manual tong reset. */
export function SurfaceCards({ state, tracking }: Props) {
  return (
    <div className="surface-grid">
      {SURFACE_ORDER.map(id => <SurfaceCard key={id} id={id} state={state} tracking={tracking} />)}
    </div>
  );
}

function SurfaceCard({ id, state, tracking }: Props & { id: ExposableSurfaceId }) {
  const { status } = state.surfaces[id];
  const source = id === "peanut-source";
  const trackingNote = isTool(id) && tracking ? TRACKING_NOTES[tracking] : undefined;
  return (
    <article className={`surface-card ${source ? "source" : status}${trackingNote && tracking === "lost" ? " tracking-lost" : ""}`}
      aria-label={SURFACE_LABELS[id]}>
      <span className="surface-name">{SURFACE_LABELS[id]}</span>
      <strong className="surface-status">{source ? SOURCE_LABEL : STATUS_LABELS[status]}</strong>
      {source && <span className="surface-note">Starts every session with peanut</span>}
      {id === "hands" && state.lastWash && (
        <span className="surface-note wash">
          {WASH_LABEL} · {WASH_METHODS[state.lastWash.method]} · {clockTime(state.lastWash.t)}
        </span>
      )}
      {/* A3: one utensil wash clears tip and handle together, so both cards carry it, like the hand wash on Hands. */}
      {isTool(id) && state.lastUtensilWash && (
        <span className="surface-note wash">
          {`${utensilWashText(state.lastUtensilWash.method)} · ${clockTime(state.lastUtensilWash.t)}`}
        </span>
      )}
      {trackingNote && <span className={`surface-note${tracking === "lost" ? " warn" : ""}`}>{trackingNote}</span>}
    </article>
  );
}
