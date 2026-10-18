// Zone, tong-face and touch-height calibration, the same tools as the vision dev page. Drawing happens on
// the camera feed; everything saves to this device's storage, which the vision page shares.

import { TONG_MARKER_IDS, createTongMarkerSheet } from "../../vision/aruco";
import { CALIBRATION_ZONE_IDS, TOUCH_LABELS, TOUCH_TARGETS, calibratedFacesText, markerStatusText, touchRefsText } from "../../vision/calibration";
import { overlappingZones } from "../../vision/geometry";
import { ZONE_LABELS } from "../labels";
import type { Calibration } from "../useCalibration";
import type { LiveVision } from "../useLiveVision";

interface Props {
  vision: LiveVision;
  calibration: Calibration;
}

const confirmed = (text: string) => typeof window === "undefined" || window.confirm(text);

function printMarkers() {
  const url = URL.createObjectURL(new Blob([createTongMarkerSheet()], { type: "text/html" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function CalibrationControls({ vision, calibration: c }: Props) {
  const live = vision.phase === "live";
  const { zones, utensilModels, frame } = vision;
  const overlapping = new Set(overlappingZones(zones).flat());
  const setCount = CALIBRATION_ZONE_IDS.filter(id => zones[id].length).length;
  const faces = utensilModels.tongs?.markers.length ?? 0;
  const markers = live && frame?.markerFrame ? markerStatusText(frame.markers, frame.markerFrame, utensilModels) : "Camera off";

  return (
    <div className="calibration">
      <p className="scope-note calibration-intro">
        Start the camera, then draw on the feed. Calibration is saved on this device and shared with the vision page.
        {!live && " The camera is off, so calibration is paused."}
      </p>

      <h2>Contact zones <span className="count">{setCount} / {CALIBRATION_ZONE_IDS.length}</span></h2>
      <div className="zone-buttons">
        {CALIBRATION_ZONE_IDS.map(id => {
          const state = !zones[id].length ? "Unset" : overlapping.has(id) ? "Overlaps" : "Set";
          return (
            <button key={id} className="button zone-button" aria-pressed={c.zone === id} disabled={!live} onClick={() => c.toggleZone(id)}>
              <span>{ZONE_LABELS[id]}</span>
              <span className={`zone-state${state === "Overlaps" ? " warn" : ""}`}>{state}</span>
            </button>
          );
        })}
      </div>
      <div className="controls">
        <button className="button" onClick={() => {
          if (!setCount || confirmed("Replace every zone with the placeholder demo layout?")) c.applyDemoLayout();
        }}>Use demo layout</button>
        <button className="button" disabled={!setCount} onClick={() => {
          if (confirmed("Clear every zone? Export a backup from the vision page first if you need one.")) c.clearZones();
        }}>Clear zones</button>
      </div>
      <p className="calibration-help" role="status">{c.zoneHelp}</p>

      <h2>Tong markers</h2>
      <dl className="calibration-readouts">
        <div><dt>Markers in view</dt><dd>{markers}</dd></div>
        <div><dt>Calibrated faces</dt><dd>{calibratedFacesText(utensilModels)}</dd></div>
        <div><dt>Touch heights</dt><dd>{touchRefsText(utensilModels)}</dd></div>
      </dl>
      <div className="controls">
        {TONG_MARKER_IDS.map(id => (
          <button key={id} className="button" aria-pressed={c.tong?.markerId === id} disabled={!live} onClick={() => c.toggleFace(id)}>
            {c.tong?.markerId === id ? `Cancel ID ${id}` : `Calibrate ID ${id}`}
          </button>
        ))}
        <button className="button" disabled={!faces} onClick={() => {
          if (confirmed("Clear both tong faces and their touch heights? Export a backup from the vision page first if you need one.")) c.clearTongs();
        }}>Clear calibration</button>
      </div>
      <div className="controls">
        {TOUCH_TARGETS.map(target => (
          <button key={target} className="button" aria-pressed={c.capture?.target === target} disabled={!live || !faces}
            onClick={() => c.toggleTouch(target)}>
            {c.capture?.target === target ? "Recording…" : `Record ${TOUCH_LABELS[target]} touch`}
          </button>
        ))}
        <button className="button" onClick={printMarkers}>Print tong markers {TONG_MARKER_IDS.join(" + ")}</button>
      </div>
      <p className="calibration-help" role="status">{c.tongHelp}</p>
    </div>
  );
}
