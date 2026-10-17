// Live video with the zone overlay. Coordinates stay in the raw frame (§4.4): mirroring is CSS only, and the
// polygons sit inside the same mirrored container. Text labels sit outside it so they don't read backwards.

import type { Point, Polygon, ZonedObjectId } from "../../shared/config";
import type { EngineState } from "../../shared/engine-types";
import { SINK_LABEL, SURFACE_LABELS } from "../labels";
import type { LiveVision } from "../useLiveVision";

interface Props {
  vision: LiveVision;
  surfaces: EngineState["surfaces"];
  mirrored: boolean;
  /** Camera events are being ignored because a simulated session owns the engine. */
  paused: boolean;
}

const ZONE_ORDER: ZonedObjectId[] = ["wash-station", "peanut-source", "meal-1", "tongs-handle", "tongs-tip"];
const ZONE_NAMES: Record<ZonedObjectId, string> = { ...SURFACE_LABELS, "wash-station": SINK_LABEL } as Record<ZonedObjectId, string>;

const centroid = (polygon: Polygon): Point => [
  polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length,
  polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length,
];

export function CameraView({ vision, surfaces, mirrored, paused }: Props) {
  const { videoRef, phase, frame, size, zones } = vision;
  const width = size?.width ?? 1280, height = size?.height ?? 720;
  const live = phase === "live" && frame !== null;
  const tongs = frame?.status.utensils.tongs;

  /** Tip and handle follow the tracked pose; lost tongs have no polygons; fixed tongs use the static layout. */
  const polygon = (id: ZonedObjectId): Polygon => {
    if ((id === "tongs-tip" || id === "tongs-handle") && tongs && tongs.tracking !== "fixed") return tongs.parts?.[id] ?? [];
    return zones[id];
  };
  const zoneClass = (id: ZonedObjectId) => {
    const active = frame?.status.activeZones.some(zone => zone === id) ||
      frame?.status.activeToolContacts.some(({ a, b }) => a === id || b === id);
    const tone = id === "wash-station" ? "wash" : id === "peanut-source" ? "source" : surfaces[id].status;
    return `zone ${tone}${active ? " active" : ""}`;
  };
  const shown = live ? ZONE_ORDER.filter(id => polygon(id).length >= 3) : [];
  const points = (polygon: Polygon) => polygon.map(([x, y]) => `${x * width},${y * height}`).join(" ");
  // With a calibrated tong model, empty static tip and handle zones are expected.
  const tracksTongs = !!vision.utensilModels.tongs?.markers.length;
  const unset = ZONE_ORDER.filter(id => !zones[id].length && !(tracksTongs && (id === "tongs-tip" || id === "tongs-handle")));

  return (
    <div className="stage" style={{ aspectRatio: `${width} / ${height}` }}>
      <div className={`feed${mirrored ? " mirrored" : ""}`}>
        <video ref={videoRef} autoPlay muted playsInline />
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {shown.map(id => <polygon key={id} className={zoneClass(id)} points={points(polygon(id))} />)}
          {live && frame.jawPoints?.map(([x, y], i) => <circle key={i} className="jaw" cx={x * width} cy={y * height} r={7} />)}
          {live && frame.fingertips.map(([x, y], i) => <circle key={i} className="fingertip" cx={x * width} cy={y * height} r={6} />)}
        </svg>
      </div>
      <div className="zone-labels" aria-hidden="true">
        {shown.map(id => {
          const [x, y] = centroid(polygon(id));
          return <span key={id} style={{ left: `${(mirrored ? 1 - x : x) * 100}%`, top: `${y * 100}%` }}>{ZONE_NAMES[id]}</span>;
        })}
      </div>
      {phase !== "live" && (
        <div className="stage-empty">
          <strong>{phase === "starting" ? "Starting camera…" : "Camera off"}</strong>
          <span>Frames are processed on this device. Nothing is uploaded.</span>
        </div>
      )}
      {live && tongs?.tracking === "lost" && <div className="stage-flag warn">Tong tracking lost — contacts not recorded</div>}
      {live && paused && <div className="stage-flag">SIMULATED session — camera events paused until reset</div>}
      {live && unset.length > 0 && (
        <div className="stage-flag bottom">Zones not calibrated: {unset.map(id => ZONE_NAMES[id]).join(", ")}. <a href="./">Calibrate on the vision page</a></div>
      )}
    </div>
  );
}
