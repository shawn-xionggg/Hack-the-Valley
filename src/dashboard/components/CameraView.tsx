// Live video and overlay share a CSS vertical flip and optional horizontal mirror.
// Coordinates stay in the raw frame (§4.4). Labels sit outside the transformed feed so they stay readable.

import type { PointerEvent } from "react";
import type { Point, Polygon, ZonedObjectId } from "../../shared/config";
import type { EngineState } from "../../shared/engine-types";
import { ZONE_LABELS } from "../labels";
import type { Calibration, ScreenSize } from "../useCalibration";
import type { LiveVision } from "../useLiveVision";

interface Props {
  vision: LiveVision;
  surfaces: EngineState["surfaces"];
  mirrored: boolean;
  /** Camera events are being ignored because a simulated session owns the engine. */
  paused: boolean;
  /** Operator calibration: draws on the feed while a zone or tong step is selected. */
  calibration?: Calibration;
  /** Outline every ArUco tag in view (while the operator controls are open). */
  showMarkers?: boolean;
}

const ZONE_ORDER: ZonedObjectId[] = ["wash-station", "peanut-source", "meal-1", "tongs-handle", "tongs-tip"];
const ZONE_NAMES = ZONE_LABELS;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

const centroid = (polygon: Polygon): Point => [
  polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length,
  polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length,
];

export function CameraView({ vision, surfaces, mirrored, paused, calibration, showMarkers = false }: Props) {
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
    return `zone ${tone}${active ? " active" : ""}${calibration?.zone === id ? " selected" : ""}`;
  };
  const shown = live ? ZONE_ORDER.filter(id => polygon(id).length >= 3) : [];
  const points = (polygon: Polygon) => polygon.map(([x, y]) => `${x * width},${y * height}`).join(" ");
  // With a calibrated tong model, empty static tip and handle zones are expected.
  const tracksTongs = !!vision.utensilModels.tongs?.markers.length;
  const unset = ZONE_ORDER.filter(id => !zones[id].length && !(tracksTongs && (id === "tongs-tip" || id === "tongs-handle")));
  const markers = live && showMarkers ? frame.markers.filter(m => m.corners.length === 4) : [];
  const drawing = calibration?.drawing ? calibration : undefined;

  /** Undo the feed's CSS flip (and mirror) so a click lands on the raw frame. */
  const toRaw = (event: PointerEvent<HTMLDivElement>): [Point, ScreenSize] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / bounds.width);
    const y = clamp((event.clientY - bounds.top) / bounds.height);
    return [[mirrored ? 1 - x : x, 1 - y], { width: bounds.width, height: bounds.height }];
  };
  const pointerHandlers = drawing && {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => drawing.pointerDown(...toRaw(event)),
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => drawing.pointerMove(...toRaw(event)),
    onPointerLeave: () => drawing.pointerLeave(),
  };

  return (
    <div className={`stage${drawing ? " calibrating" : ""}`} style={{ aspectRatio: `${width} / ${height}` }} {...pointerHandlers}>
      <div className={`feed${mirrored ? " mirrored" : ""}`}>
        <video ref={videoRef} autoPlay muted playsInline />
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {shown.map(id => <polygon key={id} className={zoneClass(id)} points={points(polygon(id))} />)}
          {live && frame.jawPoints?.map(([x, y], i) => <circle key={i} className="jaw" cx={x * width} cy={y * height} r={7} />)}
          {live && frame.fingertips.map(([x, y], i) => <circle key={i} className="fingertip" cx={x * width} cy={y * height} r={6} />)}
          {markers.map(m => <polygon key={`marker-${m.id}`} className="marker-box" points={points(m.corners)} />)}
          {drawing && <CalibrationDraft calibration={drawing} width={width} height={height} />}
        </svg>
      </div>
      <div className="zone-labels" aria-hidden="true">
        {shown.map(id => {
          const [x, y] = centroid(polygon(id));
          return <span key={id} style={{ left: `${(mirrored ? 1 - x : x) * 100}%`, top: `${(1 - y) * 100}%` }}>{ZONE_NAMES[id]}</span>;
        })}
        {markers.map(m => {
          const [x, y] = centroid(m.corners);
          return <span key={`marker-${m.id}`} className="marker-label" style={{ left: `${(mirrored ? 1 - x : x) * 100}%`, top: `${(1 - y) * 100}%` }}>ArUco {m.id}</span>;
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
      {drawing?.prompt && <div className="stage-flag calibration-prompt">{drawing.prompt}</div>}
      {live && unset.length > 0 && !drawing && (
        <div className="stage-flag bottom">Zones not calibrated: {unset.map(id => ZONE_NAMES[id]).join(", ")}. Outline them under Operator controls.</div>
      )}
    </div>
  );
}

/** The outline being drawn, plus the frozen marker and finished parts of a tong face calibration. */
function CalibrationDraft({ calibration, width, height }: { calibration: Calibration; width: number; height: number }) {
  const { tong, draft, cursor, closing } = calibration;
  const points = (polygon: readonly Point[]) => polygon.map(([x, y]) => `${x * width},${y * height}`).join(" ");
  const first = draft[0], last = draft[draft.length - 1];
  const jaws = tong?.step === "jaws";
  const end = closing ? first : cursor;
  return (
    <g className="calibration-draft">
      {tong && <polygon className="marker-frozen" points={points(tong.corners)} />}
      {tong && (["tongs-tip", "tongs-handle"] as const).map(part => {
        const polygon = tong.parts[part];
        return polygon && <polygon key={part} className={`draft-part ${part}`} points={points(polygon)} />;
      })}
      {!jaws && draft.length > 1 && <polyline className="draft-line" points={points(draft)} />}
      {!jaws && last && end && <line className="draft-line rubber" x1={last[0] * width} y1={last[1] * height} x2={end[0] * width} y2={end[1] * height} />}
      {draft.map(([x, y], i) => (
        <circle key={i} className={jaws ? "draft-jaw" : i === 0 ? "draft-point first" : "draft-point"}
          cx={x * width} cy={y * height} r={jaws ? 8 : i === 0 && closing ? 10 : 5} />
      ))}
    </g>
  );
}
